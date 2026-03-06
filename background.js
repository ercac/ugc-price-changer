// CSRF token cached in memory (lost on service worker restart, re-fetched automatically)
let csrfToken = null;

// --- Rate Limiting ---

const RATE_LIMIT_DELAY = 100; // ms between API calls
let lastRequestTime = 0;

async function throttle() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_DELAY) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY - elapsed));
  }
  lastRequestTime = Date.now();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Cookie & Auth ---

async function getRobloxCookie() {
  const cookie = await chrome.cookies.get({
    url: "https://www.roblox.com",
    name: ".ROBLOSECURITY",
  });
  return cookie ? cookie.value : null;
}

// Fetch wrapper with auth, CSRF retry, throttling, and 429 backoff
async function robloxFetch(url, options = {}) {
  const cookie = await getRobloxCookie();
  if (!cookie) throw new Error("NOT_AUTHENTICATED");

  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();

    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };

    if (csrfToken && options.method && options.method !== "GET") {
      headers["X-CSRF-Token"] = csrfToken;
    }

    let response = await fetch(url, {
      ...options,
      headers,
      credentials: "include",
    });

    // Handle CSRF token challenge
    if (response.status === 403) {
      const newToken = response.headers.get("X-CSRF-Token");
      if (newToken) {
        csrfToken = newToken;
        headers["X-CSRF-Token"] = newToken;
        await throttle();
        response = await fetch(url, {
          ...options,
          headers,
          credentials: "include",
        });
      }
    }

    // Handle rate limiting with exponential backoff
    if (response.status === 429) {
      if (attempt < MAX_RETRIES) {
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter
          ? Number(retryAfter) * 1000
          : 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        console.log(`[UGC] Rate limited, waiting ${waitMs}ms before retry ${attempt + 1}`);
        await sleep(waitMs);
        continue;
      }
    }

    return response;
  }
}

// --- Cache ---

const CACHE_TTL = 3 * 60 * 1000; // 3 minutes
let itemCache = { data: null, timestamp: 0 };

// --- Watchlist Storage ---

async function getWatchlist() {
  const data = await chrome.storage.local.get("watchlist");
  return data.watchlist || []; // array of asset ID numbers
}

async function saveWatchlist(watchlist) {
  await chrome.storage.local.set({ watchlist });
}

// --- Roblox API Functions ---

async function getCatalogDetails(assetIds) {
  if (assetIds.length === 0) return [];

  const items = assetIds.map((id) => ({ itemType: "Asset", id }));
  const allDetails = [];

  for (let i = 0; i < items.length; i += 120) {
    const batch = items.slice(i, i + 120);
    const response = await robloxFetch(
      "https://catalog.roblox.com/v1/catalog/items/details",
      {
        method: "POST",
        body: JSON.stringify({ items: batch }),
      }
    );
    if (!response.ok) throw new Error("Failed to get catalog details");
    const data = await response.json();
    allDetails.push(...data.data);
  }

  return allDetails;
}

async function getThumbnails(assetIds) {
  if (assetIds.length === 0) return {};

  const allThumbnails = {};

  for (let i = 0; i < assetIds.length; i += 100) {
    const batch = assetIds.slice(i, i + 100);
    const ids = batch.join(",");
    const response = await robloxFetch(
      `https://thumbnails.roblox.com/v1/assets?assetIds=${ids}&size=110x110&format=Png&isCircular=false`
    );
    if (!response.ok) throw new Error("Failed to get thumbnails");
    const data = await response.json();
    for (const item of data.data) {
      if (item.state === "Completed") {
        allThumbnails[item.targetId] = item.imageUrl;
      }
    }
  }

  return allThumbnails;
}

// --- Resale API Functions ---

async function getAuthenticatedUser() {
  const response = await robloxFetch(
    "https://users.roblox.com/v1/users/authenticated"
  );
  if (!response.ok) throw new Error("Failed to get authenticated user");
  return response.json();
}

async function getResellableInstances(collectibleItemId, userId) {
  const allInstances = [];
  let cursor = "";

  do {
    const url = `https://apis.roblox.com/marketplace-sales/v1/item/${collectibleItemId}/resellable-instances?ownerType=User&ownerId=${userId}&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
    const response = await robloxFetch(url);
    if (!response.ok) throw new Error("Failed to get resellable instances");
    const data = await response.json();
    if (data.itemInstances) allInstances.push(...data.itemInstances);
    cursor = data.nextPageCursor || "";
  } while (cursor);

  return allInstances;
}

async function updateResalePrice(collectibleItemId, instanceId, productId, price, userId) {
  const url = `https://apis.roblox.com/marketplace-sales/v1/item/${collectibleItemId}/instance/${instanceId}/resale`;
  const body = JSON.stringify({
    collectibleProductId: productId,
    isOnSale: true,
    price: Number(price),
    sellerId: String(userId),
    sellerType: "User",
  });

  const response = await robloxFetch(url, { method: "PATCH", body });

  if (response.status === 403) {
    const challengeId = response.headers.get("rblx-challenge-id");
    const challengeMetaB64 = response.headers.get("rblx-challenge-metadata");

    if (challengeId && challengeMetaB64) {
      // 2FA challenge required — return challenge info so popup can prompt for code
      let metadata;
      try {
        metadata = JSON.parse(atob(challengeMetaB64));
      } catch (e) {
        throw new Error("Failed to decode challenge metadata");
      }

      return {
        needsChallenge: true,
        challengeId,
        challengeMetadata: metadata,
        // Store original request info for retry
        retryInfo: { url, body, collectibleItemId, instanceId, productId, price, userId },
      };
    }

    const text = await response.text().catch(() => "");
    throw new Error(`Failed to update price (403): ${text}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to update price (${response.status}): ${text}`);
  }

  return { success: true };
}

async function verify2FAAndRetry(challengeId, challengeMetadata, twoFACode, userId, retryInfo) {
  // Step 1: Verify the 2FA code
  const verifyUrl = `https://twostepverification.roblox.com/v1/users/${userId}/challenges/authenticator/verify`;
  const verifyResponse = await robloxFetch(verifyUrl, {
    method: "POST",
    body: JSON.stringify({
      actionType: "Generic",
      challengeId: challengeMetadata.challengeId,
      code: twoFACode,
    }),
  });

  if (!verifyResponse.ok) {
    const text = await verifyResponse.text().catch(() => "");
    throw new Error(`2FA verification failed: ${text}`);
  }

  const verifyData = await verifyResponse.json();
  const verificationToken = verifyData.verificationToken;

  if (!verificationToken) {
    throw new Error("No verification token received");
  }

  // Step 2: Continue the challenge
  const continueUrl = "https://apis.roblox.com/challenge/v1/continue";
  const continueResponse = await robloxFetch(continueUrl, {
    method: "POST",
    body: JSON.stringify({
      challengeId: challengeId,
      challengeMetadata: JSON.stringify({
        rememberDevice: false,
        actionType: "Generic",
        verificationToken: verificationToken,
        challengeId: challengeMetadata.challengeId,
      }),
      challengeType: "twostepverification",
    }),
  });

  if (!continueResponse.ok) {
    const text = await continueResponse.text().catch(() => "");
    throw new Error(`Challenge continue failed: ${text}`);
  }

  // Step 3: Retry the original request with challenge headers
  const challengeMetaForRetry = btoa(JSON.stringify({
    rememberDevice: false,
    actionType: "Generic",
    verificationToken: verificationToken,
    challengeId: challengeMetadata.challengeId,
  }));

  const retryResponse = await robloxFetch(retryInfo.url, {
    method: "PATCH",
    body: retryInfo.body,
    headers: {
      "rblx-challenge-id": challengeId,
      "rblx-challenge-type": "twostepverification",
      "rblx-challenge-metadata": challengeMetaForRetry,
    },
  });

  if (!retryResponse.ok) {
    const text = await retryResponse.text().catch(() => "");
    throw new Error(`Retry failed (${retryResponse.status}): ${text}`);
  }

  return { success: true };
}

// --- Pending 2FA Queue ---

async function getPending2FA() {
  const data = await chrome.storage.local.get("pending2FA");
  return data.pending2FA || [];
}

async function addPending2FA(entry) {
  const queue = await getPending2FA();
  queue.push(entry);
  await chrome.storage.local.set({ pending2FA: queue });
  chrome.action.setBadgeText({ text: String(queue.length) });
  chrome.action.setBadgeBackgroundColor({ color: "#e74c3c" });
}

async function removePending2FA(index) {
  const queue = await getPending2FA();
  queue.splice(index, 1);
  await chrome.storage.local.set({ pending2FA: queue });
  if (queue.length === 0) {
    chrome.action.setBadgeText({ text: "" });
  } else {
    chrome.action.setBadgeText({ text: String(queue.length) });
  }
}

async function clearAllPending2FA() {
  await chrome.storage.local.set({ pending2FA: [] });
  chrome.action.setBadgeText({ text: "" });
}

// --- Auto-List Engine ---

let autoListRunning = false;
let autoListTimerId = null;

async function getAutoListSettings() {
  const data = await chrome.storage.local.get("autoListSettings");
  const defaults = {
    enabled: false,
    intervalMin: 5,       // minutes between cycles
    undercutAmount: 1,    // R$ to undercut by
    priceFloors: {},      // { assetId: minPrice }
    listCounts: {},       // { assetId: count } — how many copies to list
    protectedSellers: [], // [{ id, username, avatarUrl }] — alt accounts to not undercut
  };
  if (!data.autoListSettings) return defaults;
  // Merge stored settings with defaults so new fields are always present
  return { ...defaults, ...data.autoListSettings };
}

async function saveAutoListSettings(settings) {
  await chrome.storage.local.set({ autoListSettings: settings });
}

function randomJitter(baseMs) {
  // Add ±20% jitter so timing doesn't look robotic
  const jitter = baseMs * 0.2 * (Math.random() * 2 - 1);
  return Math.round(baseMs + jitter);
}

async function runAutoListCycle() {
  const settings = await getAutoListSettings();
  if (!settings.enabled) {
    autoListRunning = false;
    return;
  }

  console.log("[AutoList] Starting cycle...");
  const log = [];

  try {
    const user = await getAuthenticatedUser();
    const userId = user.id;
    const watchlist = await getWatchlist();

    if (watchlist.length === 0) {
      log.push({ msg: "No items in watchlist", time: Date.now() });
      scheduleNextCycle(settings);
      return { log };
    }

    const catalogDetails = await getCatalogDetails(watchlist);

    for (const detail of catalogDetails) {
      if (!detail.collectibleItemId) continue;

      const floor = settings.priceFloors[detail.id] || 0;
      const listCount = settings.listCounts[detail.id] || 1;

      try {
        // Get the lowest reseller on the market
        const resellers = await getResellers(detail.collectibleItemId, 1);
        if (resellers.length === 0) {
          log.push({ item: detail.name, msg: "No resellers found, skipping", time: Date.now() });
          continue;
        }

        const bestSeller = resellers[0];

        // If we're already the cheapest — skip
        if (bestSeller.sellerId === userId) {
          log.push({ item: detail.name, msg: `Already best seller at R$ ${bestSeller.price}, skipping`, time: Date.now() });
          continue;
        }

        // If a protected alt is the cheapest — skip (don't undercut them)
        // Match by ID or by username as fallback
        const isProtected = settings.protectedSellers.length > 0 && settings.protectedSellers.some((s) =>
          (s.id && bestSeller.sellerId && s.id === bestSeller.sellerId) ||
          (s.username && bestSeller.sellerName && s.username.toLowerCase() === bestSeller.sellerName.toLowerCase())
        );
        if (isProtected) {
          log.push({ item: detail.name, msg: `Protected alt (${bestSeller.sellerName}) is lowest at R$ ${bestSeller.price}, skipping`, time: Date.now() });
          continue;
        }

        // Undercut the cheapest price
        let targetPrice = bestSeller.price - settings.undercutAmount;
        if (targetPrice < 1) targetPrice = 1;

        // Enforce price floor
        if (floor > 0 && targetPrice < floor) {
          log.push({ item: detail.name, msg: `Target R$ ${targetPrice} below floor R$ ${floor}, skipping`, time: Date.now() });
          continue;
        }

        // Get our resellable instances
        const instances = await getResellableInstances(detail.collectibleItemId, userId);
        if (instances.length === 0) {
          log.push({ item: detail.name, msg: "No resellable instances", time: Date.now() });
          continue;
        }

        // Determine how many copies to list (capped by available instances)
        const copiesToList = Math.min(listCount, instances.length);
        let listedCount = 0;
        let skippedCount = 0;
        let twoFAHit = false;

        for (let c = 0; c < copiesToList; c++) {
          const inst = instances[c];

          // Skip if this copy is already listed at the target price
          if (inst.saleState === "OnSale" && inst.price === targetPrice) {
            skippedCount++;
            continue;
          }

          const result = await updateResalePrice(
            detail.collectibleItemId,
            inst.collectibleInstanceId,
            inst.collectibleProductId,
            targetPrice,
            userId
          );

          if (result.needsChallenge) {
            await addPending2FA({
              itemName: detail.name,
              assetId: detail.id,
              targetPrice: targetPrice,
              challengeId: result.challengeId,
              challengeMetadata: result.challengeMetadata,
              retryInfo: result.retryInfo,
              userId,
              time: Date.now(),
              fromAutoList: true, // tag so we can resume after resolution
            });
            twoFAHit = true;
            break; // 2FA blocks all subsequent copies too
          }

          listedCount++;

          // Small delay between copies
          if (c < copiesToList - 1) {
            await sleep(500 + Math.random() * 1000);
          }
        }

        if (twoFAHit) {
          log.push({ item: detail.name, msg: `2FA required — queued (${listedCount} listed before)`, time: Date.now() });
          break; // Stop processing more items — only one 2FA challenge at a time
        } else if (listedCount > 0) {
          const copyText = listedCount > 1 ? `${listedCount} copies` : "1 copy";
          log.push({ item: detail.name, msg: `${copyText} at R$ ${targetPrice} (undercut R$ ${bestSeller.price})`, time: Date.now(), success: true });
        } else {
          log.push({ item: detail.name, msg: `Already listed at R$ ${targetPrice} (${skippedCount} copies)`, time: Date.now() });
        }

        // Random delay between items (2-5s) to look human
        await sleep(2000 + Math.random() * 3000);

      } catch (e) {
        log.push({ item: detail.name, msg: `Error: ${e.message}`, time: Date.now() });
      }
    }
  } catch (e) {
    log.push({ msg: `Cycle error: ${e.message}`, time: Date.now() });
  }

  console.log("[AutoList] Cycle complete:", log);

  // Persist last run log
  await chrome.storage.local.set({ autoListLog: log, autoListLastRun: Date.now() });

  // Invalidate item cache so popup shows fresh data
  itemCache = { data: null, timestamp: 0 };

  scheduleNextCycle(settings);
  return { log };
}

function scheduleNextCycle(settings) {
  if (autoListTimerId) clearTimeout(autoListTimerId);

  if (!settings.enabled) {
    autoListRunning = false;
    return;
  }

  const intervalMs = settings.intervalMin * 60 * 1000;
  const nextMs = randomJitter(intervalMs);
  console.log(`[AutoList] Next cycle in ${Math.round(nextMs / 1000)}s`);

  autoListTimerId = setTimeout(() => {
    runAutoListCycle();
  }, nextMs);

  autoListRunning = true;
}

function startAutoList(settings) {
  settings.enabled = true;
  saveAutoListSettings(settings);
  // Run first cycle immediately
  runAutoListCycle();
}

function stopAutoList() {
  if (autoListTimerId) clearTimeout(autoListTimerId);
  autoListTimerId = null;
  autoListRunning = false;
  getAutoListSettings().then((s) => {
    s.enabled = false;
    saveAutoListSettings(s);
  });
}

// --- Reseller Lookup ---

async function getResellers(collectibleItemId, limit = 10) {
  const url = `https://apis.roblox.com/marketplace-sales/v1/item/${collectibleItemId}/resellers?limit=${limit}&sortOrder=Asc`;
  const response = await robloxFetch(url);
  if (!response.ok) return [];

  const data = await response.json();
  if (!data.data || data.data.length === 0) return [];

  return data.data.map((entry) => ({
    price: entry.price,
    sellerId: entry.seller?.sellerId ?? entry.seller?.id ?? null,
    sellerName: entry.seller?.name ?? null,
  }));
}



// --- Handlers ---

async function handleGetItems(forceRefresh = false) {
  const watchlist = await getWatchlist();

  if (watchlist.length === 0) {
    itemCache = { data: null, timestamp: 0 };
    return { items: [] };
  }

  // Return cached data if fresh
  if (!forceRefresh && itemCache.data && (Date.now() - itemCache.timestamp) < CACHE_TTL) {
    console.log("[UGC] Returning cached items");
    return itemCache.data;
  }

  // Get user ID for resellable instance lookups
  let userId = null;
  try {
    const user = await getAuthenticatedUser();
    userId = user.id;
    console.log("[UGC] Authenticated user ID:", userId);
  } catch (e) {
    console.warn("[UGC] Not authenticated:", e.message);
  }

  const [catalogDetails, thumbnails, autoSettings] = await Promise.all([
    getCatalogDetails(watchlist),
    getThumbnails(watchlist),
    getAutoListSettings(),
  ]);

  // Fetch resellable instances for items that have a collectibleItemId
  const items = [];
  for (const detail of catalogDetails) {
    const item = {
      assetId: detail.id,
      name: detail.name,
      creatorName: detail.creatorName || null,
      collectibleItemId: detail.collectibleItemId || null,
      lowestPrice: detail.lowestPrice || null,
      price: detail.price || null,
      thumbnailUrl: thumbnails[detail.id] || null,
      // Resale fields
      collectibleInstanceId: null,
      collectibleProductId: null,
      saleState: null,
      resalePrice: null,
      ownedCount: 0,
      userLowestPrice: null,
      isBestPrice: false,
      isProtectedSeller: false,
      bestSeller: null,
      priceFloor: autoSettings.priceFloors[detail.id] || 0,
      listCount: autoSettings.listCounts[detail.id] || 1,
      allInstances: [],
    };

    console.log("[UGC] Item:", detail.name, "| collectibleItemId:", detail.collectibleItemId, "| userId:", userId);

    // Fetch resellers (top 10 lowest)
    let allResellers = [];
    if (detail.collectibleItemId) {
      try {
        allResellers = await getResellers(detail.collectibleItemId);
        if (allResellers.length > 0) {
          item.bestSeller = allResellers[0]; // absolute lowest for display
        }
      } catch (e) {
        console.warn("[UGC] Reseller lookup failed for", detail.name, ":", e.message);
      }
    }

    if (userId && detail.collectibleItemId) {
      try {
        const instances = await getResellableInstances(detail.collectibleItemId, userId);
        console.log("[UGC] Resellable instances for", detail.name, ":", instances.length);
        item.ownedCount = instances.length;

        if (instances.length > 0) {
          // Use the first instance for price editing
          const inst = instances[0];
          item.collectibleInstanceId = inst.collectibleInstanceId || null;
          item.collectibleProductId = inst.collectibleProductId || null;
          item.saleState = inst.saleState || null;
          item.resalePrice = inst.price || null;

          // Find user's lowest listed price across all instances
          const listedInstances = instances.filter((i) => i.saleState === "OnSale" && i.price > 0);
          if (listedInstances.length > 0) {
            const userLowest = Math.min(...listedInstances.map((i) => i.price));
            item.userLowestPrice = userLowest;
            // Check if WE are the actual best seller (by user ID, not just price match)
            item.isBestPrice = item.bestSeller && item.bestSeller.sellerId === userId;
            item.isProtectedSeller = !item.isBestPrice && item.bestSeller && autoSettings.protectedSellers.some((s) => (s.id && item.bestSeller.sellerId && s.id === item.bestSeller.sellerId) || (s.username && item.bestSeller.sellerName && s.username.toLowerCase() === item.bestSeller.sellerName.toLowerCase()));
          }

          // Store all instances for bulk price editing later
          item.allInstances = instances.map((i) => ({
            collectibleInstanceId: i.collectibleInstanceId,
            collectibleProductId: i.collectibleProductId,
            serialNumber: i.serialNumber,
            saleState: i.saleState,
            price: i.price,
          }));
        }
      } catch (e) {
        console.warn("[UGC] Resellable instances failed for", detail.name, ":", e.message);
      }
    } else {
      console.log("[UGC] Skipping resellable check - userId:", userId, "collectibleItemId:", detail.collectibleItemId);
    }

    items.push(item);
  }

  const result = { items, userId };
  itemCache = { data: result, timestamp: Date.now() };
  return result;
}

async function handleAddItem(assetId) {
  const id = Number(assetId);
  if (!id || id <= 0) throw new Error("Invalid asset ID");

  const watchlist = await getWatchlist();
  if (watchlist.includes(id)) throw new Error("Item already in watchlist");

  // Validate that the item exists by fetching its details
  const details = await getCatalogDetails([id]);
  if (details.length === 0) throw new Error("Item not found on Roblox");

  watchlist.push(id);
  await saveWatchlist(watchlist);

  const thumbnails = await getThumbnails([id]);
  const detail = details[0];

  const item = {
    assetId: detail.id,
    name: detail.name,
    creatorName: detail.creatorName || null,
    collectibleItemId: detail.collectibleItemId || null,
    lowestPrice: detail.lowestPrice || null,
    price: detail.price || null,
    thumbnailUrl: thumbnails[detail.id] || null,
    collectibleInstanceId: null,
    collectibleProductId: null,
    saleState: null,
    resalePrice: null,
    ownedCount: 0,
    userLowestPrice: null,
    isBestPrice: false,
    isProtectedSeller: false,
    bestSeller: null,
    allInstances: [],
  };

  // Fetch resellers (top 10 lowest)
  let allResellers = [];
  if (detail.collectibleItemId) {
    try {
      allResellers = await getResellers(detail.collectibleItemId);
      if (allResellers.length > 0) {
        item.bestSeller = allResellers[0]; // absolute lowest for display
      }
    } catch (e) {
      // Continue without reseller data
    }
  }

  // Fetch resale instance data if possible
  try {
    const user = await getAuthenticatedUser();
    const autoSettings = await getAutoListSettings();
    if (detail.collectibleItemId) {
      const instances = await getResellableInstances(detail.collectibleItemId, user.id);
      item.ownedCount = instances.length;

      if (instances.length > 0) {
        const inst = instances[0];
        item.collectibleInstanceId = inst.collectibleInstanceId || null;
        item.collectibleProductId = inst.collectibleProductId || null;
        item.saleState = inst.saleState || null;
        item.resalePrice = inst.price || null;

        const listedInstances = instances.filter((i) => i.saleState === "OnSale" && i.price > 0);
        if (listedInstances.length > 0) {
          const userLowest = Math.min(...listedInstances.map((i) => i.price));
          item.userLowestPrice = userLowest;
          item.isBestPrice = item.bestSeller && item.bestSeller.sellerId === user.id;
          item.isProtectedSeller = !item.isBestPrice && item.bestSeller && autoSettings.protectedSellers.some((s) => (s.id && item.bestSeller.sellerId && s.id === item.bestSeller.sellerId) || (s.username && item.bestSeller.sellerName && s.username.toLowerCase() === item.bestSeller.sellerName.toLowerCase()));
        }

        item.allInstances = instances.map((i) => ({
          collectibleInstanceId: i.collectibleInstanceId,
          collectibleProductId: i.collectibleProductId,
          serialNumber: i.serialNumber,
          saleState: i.saleState,
          price: i.price,
        }));
      }
    }
  } catch (e) {
    // Continue without resale data
  }

  return item;
}

async function handleRemoveItem(assetId) {
  const id = Number(assetId);
  const watchlist = await getWatchlist();
  const filtered = watchlist.filter((wId) => wId !== id);
  await saveWatchlist(filtered);
  return { success: true };
}

// --- Message Handler (must be registered synchronously at top level for MV3) ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_ITEMS") {
    handleGetItems(message.forceRefresh || false)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "ADD_ITEM") {
    itemCache = { data: null, timestamp: 0 }; // invalidate cache
    handleAddItem(message.assetId)
      .then((item) => sendResponse({ item }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "REMOVE_ITEM") {
    itemCache = { data: null, timestamp: 0 }; // invalidate cache
    handleRemoveItem(message.assetId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "UPDATE_PRICE") {
    const { collectibleItemId, collectibleInstanceId, collectibleProductId, price, userId } = message;
    updateResalePrice(collectibleItemId, collectibleInstanceId, collectibleProductId, price, userId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "VERIFY_2FA") {
    const { challengeId, challengeMetadata, code, userId, retryInfo } = message;
    verify2FAAndRetry(challengeId, challengeMetadata, code, userId, retryInfo)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "GET_AUTOLIST_STATE") {
    getAutoListSettings().then((settings) => {
      chrome.storage.local.get(["autoListLog", "autoListLastRun"], (data) => {
        sendResponse({
          settings,
          running: autoListRunning,
          log: data.autoListLog || [],
          lastRun: data.autoListLastRun || null,
        });
      });
    });
    return true;
  }

  if (message.type === "START_AUTOLIST") {
    const settings = message.settings;
    startAutoList(settings);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "STOP_AUTOLIST") {
    stopAutoList();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "SAVE_AUTOLIST_SETTINGS") {
    saveAutoListSettings(message.settings)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "GET_PENDING_2FA") {
    getPending2FA()
      .then((queue) => sendResponse({ queue }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "RESOLVE_PENDING_2FA") {
    const { index, code, userId } = message;
    getPending2FA().then(async (queue) => {
      if (index < 0 || index >= queue.length) {
        sendResponse({ error: "Invalid challenge index" });
        return;
      }
      const entry = queue[index];
      try {
        const result = await verify2FAAndRetry(
          entry.challengeId,
          entry.challengeMetadata,
          code,
          entry.userId,
          entry.retryInfo
        );
        await removePending2FA(index);
        itemCache = { data: null, timestamp: 0 }; // invalidate cache
        sendResponse({ success: true, itemName: entry.itemName, price: entry.targetPrice });

        // If this was from auto-list and auto-list is still running,
        // schedule a quick follow-up cycle to process remaining items.
        // Items already listed at target price will be skipped automatically.
        if (entry.fromAutoList && autoListRunning) {
          const delayMs = 5000 + Math.random() * 5000; // 5-10s delay
          console.log(`[AutoList] 2FA resolved for ${entry.itemName}, resuming cycle in ${Math.round(delayMs / 1000)}s`);
          if (autoListTimerId) clearTimeout(autoListTimerId);
          autoListTimerId = setTimeout(() => {
            runAutoListCycle();
          }, delayMs);
        }
      } catch (err) {
        sendResponse({ error: err.message });
      }
    });
    return true;
  }

  if (message.type === "DISMISS_PENDING_2FA") {
    removePending2FA(message.index)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "UPDATE_MULTI_PRICE") {
    const { collectibleItemId, instances, price, userId } = message;
    (async () => {
      const results = { listed: 0, failed: 0, twoFA: false, challengeData: null };
      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        try {
          const result = await updateResalePrice(
            collectibleItemId,
            inst.collectibleInstanceId,
            inst.collectibleProductId,
            price,
            userId
          );
          if (result.needsChallenge) {
            results.twoFA = true;
            results.challengeData = result;
            break;
          }
          results.listed++;
          if (i < instances.length - 1) await sleep(500 + Math.random() * 1000);
        } catch (e) {
          results.failed++;
        }
      }
      itemCache = { data: null, timestamp: 0 };
      sendResponse(results);
    })();
    return true;
  }

  if (message.type === "SET_LIST_COUNT") {
    getAutoListSettings().then((settings) => {
      settings.listCounts[message.assetId] = Number(message.count) || 1;
      saveAutoListSettings(settings).then(() => sendResponse({ success: true }));
    });
    return true;
  }

  if (message.type === "SET_PRICE_FLOOR") {
    getAutoListSettings().then((settings) => {
      settings.priceFloors[message.assetId] = Number(message.floor) || 0;
      saveAutoListSettings(settings).then(() => sendResponse({ success: true }));
    });
    return true;
  }

  if (message.type === "SET_PROTECTED_SELLERS") {
    getAutoListSettings().then((settings) => {
      // Store as array of { id, username, avatarUrl } objects
      settings.protectedSellers = (message.sellers || []).filter((s) => s && s.id > 0);
      saveAutoListSettings(settings).then(() => {
        itemCache = { data: null, timestamp: 0 }; // invalidate so (Alt) tags refresh
        sendResponse({ success: true });
      });
    });
    return true;
  }

  if (message.type === "LOOKUP_USER") {
    (async () => {
      try {
        const userId = Number(message.userId);
        if (!userId || userId <= 0) {
          sendResponse({ error: "Invalid user ID" });
          return;
        }

        // Fetch username
        const userRes = await robloxFetch(`https://users.roblox.com/v1/users/${userId}`);
        if (!userRes.ok) {
          sendResponse({ error: "User not found" });
          return;
        }
        const userData = await userRes.json();

        // Fetch avatar headshot
        let avatarUrl = null;
        try {
          const avatarRes = await robloxFetch(
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=48x48&format=Png&isCircular=false`
          );
          if (avatarRes.ok) {
            const avatarData = await avatarRes.json();
            if (avatarData.data && avatarData.data.length > 0 && avatarData.data[0].state === "Completed") {
              avatarUrl = avatarData.data[0].imageUrl;
            }
          }
        } catch (e) {
          // Continue without avatar
        }

        sendResponse({
          success: true,
          id: userId,
          username: userData.name,
          avatarUrl,
        });
      } catch (err) {
        sendResponse({ error: err.message || "Lookup failed" });
      }
    })();
    return true;
  }
});
