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

// --- Reseller Lookup ---

async function getLowestReseller(collectibleItemId) {
  const url = `https://apis.roblox.com/marketplace-sales/v1/item/${collectibleItemId}/resellers?limit=1&sortOrder=Asc`;
  const response = await robloxFetch(url);
  if (!response.ok) return null;

  const data = await response.json();
  if (!data.data || data.data.length === 0) return null;

  const seller = data.data[0];
  return {
    price: seller.price,
    sellerId: seller.seller?.id || null,
    sellerName: seller.seller?.name || null,
  };
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

  const [catalogDetails, thumbnails] = await Promise.all([
    getCatalogDetails(watchlist),
    getThumbnails(watchlist),
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
      bestSeller: null,
      allInstances: [],
    };

    console.log("[UGC] Item:", detail.name, "| collectibleItemId:", detail.collectibleItemId, "| userId:", userId);

    // Fetch lowest reseller info
    if (detail.collectibleItemId) {
      try {
        item.bestSeller = await getLowestReseller(detail.collectibleItemId);
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
            item.isBestPrice = detail.lowestPrice != null && userLowest <= detail.lowestPrice;
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
    bestSeller: null,
    allInstances: [],
  };

  // Fetch lowest reseller info
  if (detail.collectibleItemId) {
    try {
      item.bestSeller = await getLowestReseller(detail.collectibleItemId);
    } catch (e) {
      // Continue without reseller data
    }
  }

  // Fetch resale instance data if possible
  try {
    const user = await getAuthenticatedUser();
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
          item.isBestPrice = detail.lowestPrice != null && userLowest <= detail.lowestPrice;
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
});
