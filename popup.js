document.addEventListener("DOMContentLoaded", () => {
  const loadingEl = document.getElementById("loading");
  const errorEl = document.getElementById("error");
  const errorMessageEl = document.getElementById("error-message");
  const itemListEl = document.getElementById("item-list");
  const emptyEl = document.getElementById("empty");
  const addErrorEl = document.getElementById("add-error");
  const assetInput = document.getElementById("asset-input");
  const addBtn = document.getElementById("add-btn");
  const refreshBtn = document.getElementById("refresh-btn");

  // --- Tab Bar ---
  const tabSellBtn = document.getElementById("tab-sell");
  const tabWatchBtn = document.getElementById("tab-watch");
  const sellContent = document.getElementById("sell-content");
  const watchContent = document.getElementById("watch-content");

  // --- Watch Tab DOM Refs ---
  const watchAssetInput = document.getElementById("watch-asset-input");
  const watchAddBtn = document.getElementById("watch-add-btn");
  const watchAddErrorEl = document.getElementById("watch-add-error");
  const watchLoadingEl = document.getElementById("watch-loading");
  const watchErrorEl = document.getElementById("watch-error");
  const watchErrorMessageEl = document.getElementById("watch-error-message");
  const watchItemListEl = document.getElementById("watch-item-list");
  const watchEmptyEl = document.getElementById("watch-empty");

  let activeTab = "sell";

  // --- Sell Search & Pagination ---
  const sellSearchEl = document.getElementById("sell-search");
  const sellSearchInput = document.getElementById("sell-search-input");
  const sellPaginationEl = document.getElementById("sell-pagination");
  const sellPrevBtn = document.getElementById("sell-prev");
  const sellNextBtn = document.getElementById("sell-next");
  const sellPageInfo = document.getElementById("sell-page-info");

  let allSellItems = [];
  let sellSearchQuery = "";
  let sellPage = 1;
  const SELL_PAGE_SIZE = 10;

  let currentUserId = null;

  // --- Auto-List Panel ---
  const autolistToggle = document.getElementById("autolist-toggle");
  const autolistBody = document.getElementById("autolist-body");
  const autolistArrow = document.getElementById("autolist-arrow");
  const autolistBadge = document.getElementById("autolist-badge");
  const autolistInterval = document.getElementById("autolist-interval");
  const autolistUndercut = document.getElementById("autolist-undercut");
  const autolistStartBtn = document.getElementById("autolist-start");
  const autolistStopBtn = document.getElementById("autolist-stop");
  const autolistStatus = document.getElementById("autolist-status");
  const autolistLogEl = document.getElementById("autolist-log");
  const protectedAddInput = document.getElementById("autolist-protected-input");
  const protectedAddBtn = document.getElementById("autolist-protected-add");
  const protectedListEl = document.getElementById("autolist-protected-list");

  let autolistOpen = false;
  let protectedSellers = []; // [{ id, username, avatarUrl }]

  autolistToggle.addEventListener("click", () => {
    autolistOpen = !autolistOpen;
    autolistBody.classList.toggle("hidden", !autolistOpen);
    autolistArrow.innerHTML = autolistOpen ? "&#9650;" : "&#9660;";
  });

  // --- Protected Sellers chip management ---

  function renderProtectedChips(disabled) {
    protectedListEl.innerHTML = "";
    for (const seller of protectedSellers) {
      const chip = document.createElement("div");
      chip.className = "autolist-protected-chip";

      const img = document.createElement("img");
      img.src = seller.avatarUrl || "";
      img.alt = seller.username;
      img.onerror = () => { img.style.display = "none"; };
      chip.appendChild(img);

      const name = document.createElement("span");
      name.className = "chip-name";
      name.textContent = seller.username;
      name.title = `${seller.username} (${seller.id})`;
      chip.appendChild(name);

      const removeBtn = document.createElement("button");
      removeBtn.className = "chip-remove";
      removeBtn.innerHTML = "&times;";
      removeBtn.title = "Remove";
      removeBtn.disabled = !!disabled;
      removeBtn.addEventListener("click", () => removeProtectedSeller(seller.id));
      chip.appendChild(removeBtn);

      protectedListEl.appendChild(chip);
    }
  }

  async function saveProtectedSellers() {
    await chrome.runtime.sendMessage({ type: "SET_PROTECTED_SELLERS", sellers: protectedSellers });
  }

  async function addProtectedSeller() {
    const raw = protectedAddInput.value.trim();
    const userId = Number(raw);
    if (!userId || userId <= 0 || !Number.isInteger(userId)) {
      protectedAddInput.style.borderColor = "#e74c3c";
      setTimeout(() => { protectedAddInput.style.borderColor = ""; }, 1500);
      return;
    }

    // Check duplicate
    if (protectedSellers.some((s) => s.id === userId)) {
      protectedAddInput.value = "";
      return;
    }

    protectedAddBtn.disabled = true;
    protectedAddBtn.textContent = "...";

    try {
      const res = await chrome.runtime.sendMessage({ type: "LOOKUP_USER", userId });
      if (!res || res.error) {
        protectedAddInput.style.borderColor = "#e74c3c";
        setTimeout(() => { protectedAddInput.style.borderColor = ""; }, 1500);
        return;
      }

      protectedSellers.push({ id: res.id, username: res.username, avatarUrl: res.avatarUrl });
      await saveProtectedSellers();
      renderProtectedChips(false);
      protectedAddInput.value = "";
    } catch (err) {
      protectedAddInput.style.borderColor = "#e74c3c";
      setTimeout(() => { protectedAddInput.style.borderColor = ""; }, 1500);
    } finally {
      protectedAddBtn.disabled = false;
      protectedAddBtn.textContent = "Add";
    }
  }

  async function removeProtectedSeller(id) {
    protectedSellers = protectedSellers.filter((s) => s.id !== id);
    await saveProtectedSellers();
    renderProtectedChips(false);
  }

  protectedAddBtn.addEventListener("click", addProtectedSeller);
  protectedAddInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addProtectedSeller();
  });

  autolistStartBtn.addEventListener("click", async () => {
    const settings = {
      enabled: true,
      intervalMin: Math.max(3, Number(autolistInterval.value) || 5),
      undercutAmount: Math.max(1, Number(autolistUndercut.value) || 1),
      priceFloors: {},
      listCounts: {},
      protectedSellers: protectedSellers,
    };

    // Preserve existing price floors and list counts
    const state = await chrome.runtime.sendMessage({ type: "GET_AUTOLIST_STATE" });
    if (state.settings) {
      if (state.settings.priceFloors) settings.priceFloors = state.settings.priceFloors;
      if (state.settings.listCounts) settings.listCounts = state.settings.listCounts;
    }

    await chrome.runtime.sendMessage({ type: "START_AUTOLIST", settings });
    updateAutolistUI(true);
  });

  autolistStopBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "STOP_AUTOLIST" });
    updateAutolistUI(false);
  });

  function updateAutolistUI(running) {
    autolistStartBtn.classList.toggle("hidden", running);
    autolistStopBtn.classList.toggle("hidden", !running);
    autolistBadge.classList.toggle("hidden", !running);
    autolistInterval.disabled = running;
    autolistUndercut.disabled = running;
    protectedAddInput.disabled = running;
    protectedAddBtn.disabled = running;
    renderProtectedChips(running);
  }

  function renderAutolistLog(log) {
    if (!log || log.length === 0) {
      autolistLogEl.classList.add("hidden");
      return;
    }
    autolistLogEl.classList.remove("hidden");
    autolistLogEl.innerHTML = "<div class='autolist-log-title'>Last cycle:</div>" +
      log.map((entry) => {
        const cls = entry.success ? "log-success" : "";
        const name = entry.item ? `<strong>${entry.item}</strong>: ` : "";
        return `<div class="autolist-log-entry ${cls}">${name}${entry.msg}</div>`;
      }).join("");
  }

  async function loadAutolistState() {
    const state = await chrome.runtime.sendMessage({ type: "GET_AUTOLIST_STATE" });
    if (state.settings) {
      autolistInterval.value = state.settings.intervalMin || 5;
      autolistUndercut.value = state.settings.undercutAmount || 1;
      if (state.settings.protectedSellers && state.settings.protectedSellers.length > 0) {
        protectedSellers = state.settings.protectedSellers;
        renderProtectedChips(state.running);
      }
    }
    updateAutolistUI(state.running);
    if (state.lastRun) {
      autolistStatus.classList.remove("hidden");
      const ago = Math.round((Date.now() - state.lastRun) / 1000);
      const agoText = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
      autolistStatus.textContent = `Last run: ${agoText}`;
    }
    renderAutolistLog(state.log);
  }

  loadAutolistState();

  function showState(state) {
    loadingEl.classList.toggle("hidden", state !== "loading");
    errorEl.classList.toggle("hidden", state !== "error");
    itemListEl.classList.toggle("hidden", state !== "items");
    emptyEl.classList.toggle("hidden", state !== "empty");
  }

  function formatPrice(price) {
    if (price == null) return null;
    return price.toLocaleString();
  }

  function parseAssetId(input) {
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    // Match various Roblox URL formats: /catalog/ID, /marketplace/asset/ID, /bundles/ID, or generic /ID pattern
    const urlMatch = trimmed.match(/roblox\.com\/(?:catalog|marketplace\/asset|bundles)\/(\d+)/i);
    if (urlMatch) return Number(urlMatch[1]);
    return null;
  }

  function showAddError(msg) {
    addErrorEl.textContent = msg;
    addErrorEl.classList.remove("hidden");
    setTimeout(() => addErrorEl.classList.add("hidden"), 4000);
  }

  function createItemCard(item) {
    const card = document.createElement("div");
    card.className = "item-card";
    card.dataset.assetId = item.assetId;

    const lowestText = item.lowestPrice
      ? `Lowest: R$ ${formatPrice(item.lowestPrice)}`
      : item.price
        ? `Price: R$ ${formatPrice(item.price)}`
        : "Not for sale";

    const canSell = item.collectibleInstanceId && item.collectibleProductId;
    const hasMultiple = item.allInstances && item.allInstances.length > 1;

    // Track active instance (mutable — changes when dropdown selection changes)
    const activeInstance = {
      collectibleInstanceId: item.collectibleInstanceId,
      collectibleProductId: item.collectibleProductId,
      saleState: item.saleState,
      resalePrice: item.resalePrice,
    };

    // Owned count
    let ownedHtml = "";
    if (item.ownedCount > 0) {
      ownedHtml = `<div class="item-owned">Owned: ${item.ownedCount} cop${item.ownedCount !== 1 ? "ies" : "y"}</div>`;
    }

    // Best seller info
    let bestSellerHtml = "";
    if (item.bestSeller && item.bestSeller.sellerName) {
      const sellerLink = item.bestSeller.sellerId
        ? `<a href="https://www.roblox.com/users/${item.bestSeller.sellerId}/profile" target="_blank" class="best-seller-link">${item.bestSeller.sellerName}</a>`
        : item.bestSeller.sellerName;
      const bestClass = item.isBestPrice ? " is-you" : item.isProtectedSeller ? " is-alt" : "";
      const bestTag = item.isBestPrice ? " (You!)" : item.isProtectedSeller ? " (Alt)" : "";
      bestSellerHtml = `<div class="item-best-seller${bestClass}">Best: R$ ${formatPrice(item.bestSeller.price)} by ${sellerLink}${bestTag}</div>`;
    } else if (item.isBestPrice) {
      bestSellerHtml = `<div class="item-best-seller is-you">Best Price (You!)</div>`;
    }

    // Sale state for the active instance
    function getSaleStateHtml(inst) {
      if (inst.saleState === "OnSale") {
        return `<div class="item-sale-state on-sale">Listed: R$ ${formatPrice(inst.resalePrice)}</div>`;
      } else if (inst.collectibleInstanceId && inst.collectibleProductId) {
        return `<div class="item-sale-state">Not listed</div>`;
      }
      return `<div class="item-sale-state">Not resellable</div>`;
    }

    let saleStateHtml = getSaleStateHtml(activeInstance);

    // Serial number dropdown
    let serialDropdownHtml = "";
    if (hasMultiple) {
      const options = item.allInstances.map((inst, idx) => {
        const serial = inst.serialNumber ? `#${inst.serialNumber}` : `Copy ${idx + 1}`;
        const status = inst.saleState === "OnSale" ? ` - R$ ${formatPrice(inst.price)}` : "";
        return `<option value="${idx}" ${idx === 0 ? "selected" : ""}>${serial}${status}</option>`;
      }).join("");
      serialDropdownHtml = `
        <div class="serial-select-row">
          <label class="serial-label">Serial:</label>
          <select class="serial-select">${options}</select>
        </div>
      `;
    }

    // Per-item price floor
    let floorHtml = "";
    if (canSell) {
      const floorVal = item.priceFloor || "";
      floorHtml = `
        <div class="floor-row">
          <label class="floor-label">Floor:</label>
          <input type="number" class="floor-input" min="0" placeholder="None" value="${floorVal}">
          <button class="floor-save-btn" title="Save floor price">&#10003;</button>
        </div>
      `;
    }

    // List count (only for items with 2+ copies)
    let listCountHtml = "";
    if (canSell && item.ownedCount >= 2) {
      const countVal = item.listCount || 1;
      listCountHtml = `
        <div class="listcount-row">
          <label class="listcount-label">List #:</label>
          <input type="number" class="listcount-input" min="1" max="${item.ownedCount}" value="${countVal}">
          <span class="listcount-max">/ ${item.ownedCount}</span>
          <button class="listcount-save-btn" title="Save list count">&#10003;</button>
        </div>
      `;
    }

    // Check if any copies are currently listed
    const listedInstances = (item.allInstances || []).filter((i) => i.saleState === "OnSale");
    const hasListedCopies = listedInstances.length > 0 || activeInstance.saleState === "OnSale";

    let priceEditHtml = "";
    if (canSell) {
      const delistBtnHtml = hasListedCopies
        ? `<button class="delist-all-btn">Delist All</button>`
        : "";
      priceEditHtml = `
        <div class="item-price-row">
          <input type="number" class="price-input" min="1" placeholder="${activeInstance.resalePrice || "Price"}" value="${activeInstance.resalePrice || ""}">
          <button class="price-save-btn">Set Price</button>
        </div>
        ${listCountHtml}
        ${floorHtml}
        ${delistBtnHtml}
        <div class="price-status hidden"></div>
      `;
    }

    card.innerHTML = `
      <img class="item-thumbnail"
           src="${item.thumbnailUrl || ""}"
           alt="${item.name}"
           loading="lazy"
           onerror="this.style.display='none'">
      <div class="item-info">
        <a class="item-name" href="https://www.roblox.com/catalog/${item.assetId}" target="_blank" title="${item.name}">${item.name}</a>
        ${item.creatorName ? `<div class="item-creator">by ${item.creatorName}</div>` : ""}
        <div class="item-price">${lowestText}</div>
        ${ownedHtml}
        ${serialDropdownHtml}
        ${saleStateHtml}
        ${bestSellerHtml}
        ${priceEditHtml}
      </div>
      <button class="item-remove" title="Remove item">&times;</button>
    `;

    card.querySelector(".item-remove").addEventListener("click", async () => {
      const confirmed = await showConfirm(`Are you sure you want to remove ${item.name} from this list?`);
      if (confirmed) removeItem(item.assetId, card);
    });

    // Delist All button handler
    const delistBtn = card.querySelector(".delist-all-btn");
    if (delistBtn) {
      delistBtn.addEventListener("click", async () => {
        const confirmed = await showConfirm(`Are you sure you want to delist all of ${item.name}?`);
        if (!confirmed) return;

        delistBtn.disabled = true;
        delistBtn.textContent = "Delisting...";
        const statusEl = card.querySelector(".price-status");

        try {
          const instances = item.allInstances && item.allInstances.length > 0
            ? item.allInstances
            : [activeInstance];

          const response = await chrome.runtime.sendMessage({
            type: "DELIST_ALL",
            collectibleItemId: item.collectibleItemId,
            instances,
            userId: currentUserId,
          });

          if (response.delisted > 0) {
            showToast(`Delisted ${response.delisted} cop${response.delisted !== 1 ? "ies" : "y"} of ${item.name}`);
            // Update sale state display
            const saleStateEl = card.querySelector(".item-sale-state");
            if (saleStateEl) {
              saleStateEl.textContent = "Not listed";
              saleStateEl.className = "item-sale-state";
            }
            delistBtn.remove(); // hide button since nothing is listed anymore
          } else {
            if (statusEl) {
              statusEl.textContent = "Nothing to delist";
              statusEl.className = "price-status error";
              statusEl.classList.remove("hidden");
            }
            delistBtn.disabled = false;
            delistBtn.textContent = "Delist All";
          }
        } catch (err) {
          if (statusEl) {
            statusEl.textContent = err.message;
            statusEl.className = "price-status error";
            statusEl.classList.remove("hidden");
          }
          delistBtn.disabled = false;
          delistBtn.textContent = "Delist All";
        }
      });
    }

    // Serial number dropdown change handler
    if (hasMultiple) {
      const serialSelect = card.querySelector(".serial-select");
      serialSelect.addEventListener("change", () => {
        const idx = Number(serialSelect.value);
        const inst = item.allInstances[idx];

        // Update active instance
        activeInstance.collectibleInstanceId = inst.collectibleInstanceId;
        activeInstance.collectibleProductId = inst.collectibleProductId;
        activeInstance.saleState = inst.saleState;
        activeInstance.resalePrice = inst.price;

        // Update sale state display
        const saleStateEl = card.querySelector(".item-sale-state");
        if (saleStateEl) {
          if (inst.saleState === "OnSale") {
            saleStateEl.textContent = `Listed: R$ ${formatPrice(inst.price)}`;
            saleStateEl.className = "item-sale-state on-sale";
          } else {
            saleStateEl.textContent = "Not listed";
            saleStateEl.className = "item-sale-state";
          }
        }

        // Update price input
        const priceInput = card.querySelector(".price-input");
        if (priceInput) {
          priceInput.value = inst.price || "";
          priceInput.placeholder = inst.price || "Price";
        }

        // Clear any status message
        const statusEl = card.querySelector(".price-status");
        if (statusEl) {
          statusEl.textContent = "";
          statusEl.classList.add("hidden");
        }
      });
    }

    if (canSell) {
      const saveBtn = card.querySelector(".price-save-btn");
      const priceInput = card.querySelector(".price-input");
      const statusEl = card.querySelector(".price-status");

      saveBtn.addEventListener("click", () => {
        updatePrice(item, priceInput, saveBtn, statusEl, card, activeInstance);
      });

      priceInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          updatePrice(item, priceInput, saveBtn, statusEl, card, activeInstance);
        }
      });

      // List count save
      const listcountSaveBtn = card.querySelector(".listcount-save-btn");
      const listcountInput = card.querySelector(".listcount-input");
      if (listcountSaveBtn && listcountInput) {
        async function saveListCount() {
          const val = Math.max(1, Math.min(item.ownedCount, Number(listcountInput.value) || 1));
          listcountInput.value = val;
          await chrome.runtime.sendMessage({ type: "SET_LIST_COUNT", assetId: item.assetId, count: val });
          listcountSaveBtn.textContent = "\u2713";
          listcountSaveBtn.classList.add("saved");
          setTimeout(() => {
            listcountSaveBtn.textContent = "\u2713";
            listcountSaveBtn.classList.remove("saved");
          }, 1500);
        }
        listcountSaveBtn.addEventListener("click", saveListCount);
        listcountInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") saveListCount();
        });
      }

      // Floor price save
      const floorSaveBtn = card.querySelector(".floor-save-btn");
      const floorInput = card.querySelector(".floor-input");
      if (floorSaveBtn && floorInput) {
        async function saveFloor() {
          const val = Number(floorInput.value) || 0;
          await chrome.runtime.sendMessage({ type: "SET_PRICE_FLOOR", assetId: item.assetId, floor: val });
          floorSaveBtn.textContent = "\u2713";
          floorSaveBtn.classList.add("saved");
          setTimeout(() => {
            floorSaveBtn.textContent = "\u2713";
            floorSaveBtn.classList.remove("saved");
          }, 1500);
        }
        floorSaveBtn.addEventListener("click", saveFloor);
        floorInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") saveFloor();
        });
      }
    }

    return card;
  }

  async function updatePrice(item, inputEl, btnEl, statusEl, cardEl, activeInstance) {
    const inst = activeInstance || item;
    const price = Number(inputEl.value);
    if (!price || price < 1) {
      statusEl.textContent = "Enter a valid price";
      statusEl.className = "price-status error";
      statusEl.classList.remove("hidden");
      return;
    }

    // Check if multi-copy listing is requested
    const listcountInput = cardEl.querySelector(".listcount-input");
    const copyCount = listcountInput ? Math.max(1, Number(listcountInput.value) || 1) : 1;

    btnEl.disabled = true;
    statusEl.className = "price-status";
    statusEl.classList.remove("hidden");

    // Multi-copy listing (with automatic 2FA continuation)
    if (copyCount > 1 && item.allInstances && item.allInstances.length >= 2) {
      const instancesToList = item.allInstances.slice(0, copyCount);
      let multiError = false;

      try {
        const totalListed = await listMultipleCopies(item, instancesToList, price, statusEl);

        if (totalListed > 0) {
          showToast(`${totalListed} cop${totalListed !== 1 ? "ies" : "y"} listed at R$ ${formatPrice(price)}`);
          const saleStateEl = cardEl.querySelector(".item-sale-state");
          if (saleStateEl) {
            saleStateEl.textContent = `Listed: R$ ${formatPrice(price)}`;
            saleStateEl.className = "item-sale-state on-sale";
          }
        } else {
          showToast("No copies listed");
        }
      } catch (err) {
        statusEl.textContent = err.message;
        statusEl.className = "price-status error";
        multiError = true;
      }

      btnEl.disabled = false;
      if (!multiError) {
        statusEl.textContent = "";
        statusEl.classList.add("hidden");
      }
      return;
    }

    // Single copy listing
    statusEl.textContent = "Updating...";

    try {
      const response = await chrome.runtime.sendMessage({
        type: "UPDATE_PRICE",
        collectibleItemId: item.collectibleItemId,
        collectibleInstanceId: inst.collectibleInstanceId,
        collectibleProductId: inst.collectibleProductId,
        price,
        userId: currentUserId,
      });

      if (response.error) {
        statusEl.textContent = response.error;
        statusEl.className = "price-status error";
      } else if (response.needsChallenge) {
        show2FAModal(response, price, statusEl, btnEl, cardEl);
        return;
      } else {
        showToast("Listed Successfully!");
        statusEl.textContent = "";
        statusEl.classList.add("hidden");

        const saleStateEl = cardEl.querySelector(".item-sale-state");
        if (saleStateEl) {
          saleStateEl.textContent = `Listed: R$ ${formatPrice(price)}`;
          saleStateEl.className = "item-sale-state on-sale";
        }
      }
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = "price-status error";
    }

    btnEl.disabled = false;
  }

  // --- Confirm Dialog ---
  const confirmModal = document.getElementById("confirm-modal");
  const confirmMsg = document.getElementById("confirm-msg");
  const confirmYes = document.getElementById("confirm-yes");
  const confirmNo = document.getElementById("confirm-no");

  function showConfirm(message) {
    return new Promise((resolve) => {
      confirmMsg.textContent = message;
      confirmModal.classList.remove("hidden");

      const newYes = confirmYes.cloneNode(true);
      confirmYes.parentNode.replaceChild(newYes, confirmYes);
      const newNo = confirmNo.cloneNode(true);
      confirmNo.parentNode.replaceChild(newNo, confirmNo);

      const yesBtn = document.getElementById("confirm-yes");
      const noBtn = document.getElementById("confirm-no");

      yesBtn.addEventListener("click", () => {
        confirmModal.classList.add("hidden");
        resolve(true);
      });
      noBtn.addEventListener("click", () => {
        confirmModal.classList.add("hidden");
        resolve(false);
      });
    });
  }

  // --- Global 2FA Modal & Success Toast ---
  const modal = document.getElementById("twofa-modal");
  const toast = document.getElementById("success-toast");
  const toastMsg = document.getElementById("toast-msg");

  let pendingQueue = [];
  let currentPendingIdx = 0;

  function showToast(msg) {
    toastMsg.textContent = msg;
    toast.classList.remove("hidden");
    setTimeout(() => toast.classList.add("hidden"), 3000);
  }

  function openModal(opts) {
    // opts: { itemName, desc, onSubmit(code), onSkip(), count }

    // Always get fresh DOM references (elements may have been cloned previously)
    const curItemName = document.getElementById("modal-item-name");
    const curDesc = document.getElementById("modal-desc");
    const curInput = document.getElementById("modal-2fa-input");
    const curSubmit = document.getElementById("modal-2fa-submit");
    const curError = document.getElementById("modal-2fa-error");
    const curSkip = document.getElementById("modal-2fa-skip");
    const curCount = document.getElementById("modal-2fa-count");

    curItemName.textContent = opts.itemName || "";
    curDesc.textContent = opts.desc || "";
    curInput.value = "";
    curInput.disabled = false;
    curSubmit.disabled = false;
    curSubmit.textContent = "Verify";
    curError.classList.add("hidden");
    curCount.textContent = opts.count || "";
    modal.classList.remove("hidden");

    // Remove old listeners by cloning
    const newSubmit = curSubmit.cloneNode(true);
    curSubmit.parentNode.replaceChild(newSubmit, curSubmit);
    const newSkip = curSkip.cloneNode(true);
    curSkip.parentNode.replaceChild(newSkip, curSkip);
    const newInput = curInput.cloneNode(true);
    curInput.parentNode.replaceChild(newInput, curInput);

    // Re-grab references after clone
    const submitBtn = document.getElementById("modal-2fa-submit");
    const skipBtn = document.getElementById("modal-2fa-skip");
    const inputEl = document.getElementById("modal-2fa-input");
    const errorEl = document.getElementById("modal-2fa-error");

    setTimeout(() => inputEl.focus(), 50);

    async function handleSubmit() {
      const code = inputEl.value.trim();
      if (!/^\d{6}$/.test(code)) {
        errorEl.textContent = "Enter a 6-digit code";
        errorEl.classList.remove("hidden");
        return;
      }
      errorEl.classList.add("hidden");
      submitBtn.disabled = true;
      inputEl.disabled = true;
      submitBtn.textContent = "Verifying...";

      try {
        await opts.onSubmit(code);
      } catch (err) {
        errorEl.textContent = err.message || "Verification failed";
        errorEl.classList.remove("hidden");
      } finally {
        // Always reset button state so modal never gets stuck
        submitBtn.disabled = false;
        inputEl.disabled = false;
        submitBtn.textContent = "Verify";
      }
    }

    submitBtn.addEventListener("click", handleSubmit);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleSubmit();
    });
    skipBtn.addEventListener("click", () => {
      if (opts.onSkip) opts.onSkip();
    });
  }

  function closeModal() {
    modal.classList.add("hidden");
  }

  // Check for pending 2FA challenges on popup load
  async function checkPending2FA() {
    const res = await chrome.runtime.sendMessage({ type: "GET_PENDING_2FA" });
    if (res.error || !res.queue || res.queue.length === 0) return;
    pendingQueue = res.queue;
    currentPendingIdx = 0;
    showNextPending();
  }

  function showNextPending() {
    if (currentPendingIdx >= pendingQueue.length) {
      closeModal();
      return;
    }

    const entry = pendingQueue[currentPendingIdx];
    const remaining = pendingQueue.length - currentPendingIdx;

    openModal({
      itemName: entry.itemName,
      desc: `List for R$ ${formatPrice(entry.targetPrice)}`,
      count: remaining > 1 ? `${currentPendingIdx + 1} of ${pendingQueue.length}` : "",
      onSubmit: async (code) => {
        const response = await chrome.runtime.sendMessage({
          type: "RESOLVE_PENDING_2FA",
          index: 0, // always 0 because we remove from front
          code,
          userId: entry.userId,
        });

        if (response.error) {
          throw new Error(response.error);
        }

        showToast(`Listed Successfully! ${entry.itemName} at R$ ${formatPrice(entry.targetPrice)}`);
        pendingQueue.splice(currentPendingIdx, 1);

        if (pendingQueue.length > 0) {
          // Show next one after brief pause
          setTimeout(() => showNextPending(), 500);
        } else {
          closeModal();
          loadItems(true); // refresh to show new data
        }
      },
      onSkip: async () => {
        await chrome.runtime.sendMessage({ type: "DISMISS_PENDING_2FA", index: 0 });
        pendingQueue.splice(currentPendingIdx, 1);

        if (pendingQueue.length > 0) {
          showNextPending();
        } else {
          closeModal();
        }
      },
    });
  }

  // Promise-based 2FA prompt — resolves true on success, false on skip
  function prompt2FA(challengeData, price) {
    return new Promise((resolve) => {
      openModal({
        itemName: "2FA Required",
        desc: `Listing at R$ ${formatPrice(price)}`,
        count: "",
        onSubmit: async (code) => {
          const response = await chrome.runtime.sendMessage({
            type: "VERIFY_2FA",
            challengeId: challengeData.challengeId,
            challengeMetadata: challengeData.challengeMetadata,
            code,
            userId: currentUserId,
            retryInfo: challengeData.retryInfo,
          });
          if (!response) throw new Error("No response — try again");
          if (response.error) throw new Error(response.error);
          closeModal();
          resolve(true);
        },
        onSkip: () => {
          closeModal();
          resolve(false);
        },
      });
    });
  }

  // List multiple copies with automatic continuation after each 2FA
  async function listMultipleCopies(item, instances, price, statusEl) {
    let totalListed = 0;
    let remaining = [...instances];

    while (remaining.length > 0) {
      statusEl.textContent = totalListed > 0
        ? `Listed ${totalListed}/${instances.length}, continuing...`
        : `Listing ${instances.length} copies...`;
      statusEl.className = "price-status";
      statusEl.classList.remove("hidden");

      const response = await chrome.runtime.sendMessage({
        type: "UPDATE_MULTI_PRICE",
        collectibleItemId: item.collectibleItemId,
        instances: remaining,
        price,
        userId: currentUserId,
      });

      if (!response) throw new Error("No response from background");
      if (response.error) throw new Error(response.error);

      totalListed += response.listed;

      if (response.twoFA) {
        statusEl.textContent = `Listed ${totalListed}/${instances.length} — 2FA required`;

        const continued = await prompt2FA(response.challengeData, price);
        if (!continued) break; // user skipped

        totalListed++; // the 2FA copy is now listed
        remaining = remaining.slice(response.listed + 1); // skip listed + 2FA'd one
      } else {
        break; // all remaining listed successfully
      }
    }

    return totalListed;
  }

  // For single-copy manual price update — show 2FA modal inline
  function show2FAModal(challengeData, price, statusEl, btnEl, cardEl) {
    statusEl.textContent = "2FA required...";
    statusEl.className = "price-status";
    statusEl.classList.remove("hidden");

    openModal({
      itemName: "Manual Price Update",
      desc: `Setting price to R$ ${formatPrice(price)}`,
      count: "",
      onSubmit: async (code) => {
        const response = await chrome.runtime.sendMessage({
          type: "VERIFY_2FA",
          challengeId: challengeData.challengeId,
          challengeMetadata: challengeData.challengeMetadata,
          code,
          userId: currentUserId,
          retryInfo: challengeData.retryInfo,
        });

        if (!response) throw new Error("No response — try again");
        if (response.error) throw new Error(response.error);

        closeModal();
        showToast("Listed Successfully!");

        statusEl.textContent = "";
        statusEl.classList.add("hidden");

        const saleStateEl = cardEl.querySelector(".item-sale-state");
        if (saleStateEl) {
          saleStateEl.textContent = `Listed: R$ ${formatPrice(price)}`;
          saleStateEl.className = "item-sale-state on-sale";
        }

        btnEl.disabled = false;
      },
      onSkip: () => {
        closeModal();
        statusEl.textContent = "2FA skipped";
        statusEl.className = "price-status error";
        btnEl.disabled = false;
      },
    });
  }

  function renderSellPage() {
    if (allSellItems.length === 0) {
      showState("empty");
      sellSearchEl.classList.add("hidden");
      sellPaginationEl.classList.add("hidden");
      return;
    }

    // Show search bar when there are items
    sellSearchEl.classList.remove("hidden");

    // Filter by search query
    const query = sellSearchQuery.toLowerCase();
    const filtered = query
      ? allSellItems.filter((item) => item.name.toLowerCase().includes(query))
      : allSellItems;

    if (filtered.length === 0) {
      showState("items");
      itemListEl.innerHTML = "";
      const countEl = document.createElement("div");
      countEl.className = "item-count";
      countEl.textContent = `No results for "${sellSearchQuery}"`;
      itemListEl.appendChild(countEl);
      sellPaginationEl.classList.add("hidden");
      return;
    }

    // Pagination math
    const totalPages = Math.ceil(filtered.length / SELL_PAGE_SIZE);
    if (sellPage > totalPages) sellPage = totalPages;
    if (sellPage < 1) sellPage = 1;
    const start = (sellPage - 1) * SELL_PAGE_SIZE;
    const pageItems = filtered.slice(start, start + SELL_PAGE_SIZE);

    showState("items");
    itemListEl.innerHTML = "";

    // Item count
    const countEl = document.createElement("div");
    countEl.className = "item-count";
    if (query) {
      countEl.textContent = `${filtered.length} result${filtered.length !== 1 ? "s" : ""} of ${allSellItems.length} items`;
    } else {
      countEl.textContent = `${allSellItems.length} item${allSellItems.length !== 1 ? "s" : ""}`;
    }
    itemListEl.appendChild(countEl);

    for (const item of pageItems) {
      itemListEl.appendChild(createItemCard(item));
    }

    // Pagination controls
    if (totalPages > 1) {
      sellPaginationEl.classList.remove("hidden");
      sellPageInfo.textContent = `Page ${sellPage} of ${totalPages}`;
      sellPrevBtn.disabled = sellPage <= 1;
      sellNextBtn.disabled = sellPage >= totalPages;
    } else {
      sellPaginationEl.classList.add("hidden");
    }
  }

  async function removeItem(assetId, cardEl) {
    cardEl.style.opacity = "0.5";
    const response = await chrome.runtime.sendMessage({
      type: "REMOVE_ITEM",
      assetId,
    });

    if (response.error) {
      cardEl.style.opacity = "1";
      return;
    }

    allSellItems = allSellItems.filter((item) => item.assetId !== assetId);
    renderSellPage();
  }

  async function addItem() {
    const raw = assetInput.value;
    const assetId = parseAssetId(raw);

    if (!assetId) {
      showAddError("Enter a valid asset ID or Roblox catalog URL.");
      return;
    }

    addBtn.disabled = true;
    addErrorEl.classList.add("hidden");

    const response = await chrome.runtime.sendMessage({
      type: "ADD_ITEM",
      assetId,
    });

    addBtn.disabled = false;

    if (response.error) {
      showAddError(response.error);
      return;
    }

    assetInput.value = "";

    allSellItems.push(response.item);

    // Clear search and go to last page to show the new item
    sellSearchQuery = "";
    sellSearchInput.value = "";
    const totalPages = Math.ceil(allSellItems.length / SELL_PAGE_SIZE);
    sellPage = totalPages;
    renderSellPage();
  }

  async function loadItems(forceRefresh = false) {
    showState("loading");
    sellSearchEl.classList.add("hidden");
    sellPaginationEl.classList.add("hidden");

    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_ITEMS", forceRefresh });

      if (response.error) {
        showState("error");
        errorMessageEl.textContent = response.error;
        return;
      }

      if (response.userId) {
        currentUserId = response.userId;
      }

      allSellItems = response.items;
      renderSellPage();
    } catch (err) {
      showState("error");
      errorMessageEl.textContent = `Error: ${err.message}`;
    }
  }

  addBtn.addEventListener("click", addItem);
  assetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addItem();
  });

  // --- Search & Pagination Handlers ---
  sellSearchInput.addEventListener("input", () => {
    sellSearchQuery = sellSearchInput.value.trim();
    sellPage = 1;
    renderSellPage();
  });

  sellPrevBtn.addEventListener("click", () => {
    if (sellPage > 1) {
      sellPage--;
      renderSellPage();
    }
  });

  sellNextBtn.addEventListener("click", () => {
    const query = sellSearchQuery.toLowerCase();
    const filtered = query
      ? allSellItems.filter((item) => item.name.toLowerCase().includes(query))
      : allSellItems;
    const totalPages = Math.ceil(filtered.length / SELL_PAGE_SIZE);
    if (sellPage < totalPages) {
      sellPage++;
      renderSellPage();
    }
  });

  // --- Tab Switching ---
  tabSellBtn.addEventListener("click", () => {
    if (activeTab === "sell") return;
    activeTab = "sell";
    tabSellBtn.classList.add("active");
    tabWatchBtn.classList.remove("active");
    sellContent.classList.remove("hidden");
    watchContent.classList.add("hidden");
  });

  tabWatchBtn.addEventListener("click", () => {
    if (activeTab === "watch") return;
    activeTab = "watch";
    tabWatchBtn.classList.add("active");
    tabSellBtn.classList.remove("active");
    watchContent.classList.remove("hidden");
    sellContent.classList.add("hidden");
    loadWatchItems();
  });

  // Refresh button: refresh whichever tab is active
  refreshBtn.addEventListener("click", () => {
    if (activeTab === "sell") {
      loadItems(true);
    } else {
      loadWatchItems(true);
    }
  });

  // --- Watch Tab Functions ---

  function showWatchState(state) {
    watchLoadingEl.classList.toggle("hidden", state !== "loading");
    watchErrorEl.classList.toggle("hidden", state !== "error");
    watchItemListEl.classList.toggle("hidden", state !== "items");
    watchEmptyEl.classList.toggle("hidden", state !== "empty");
  }

  function showWatchAddError(msg) {
    watchAddErrorEl.textContent = msg;
    watchAddErrorEl.classList.remove("hidden");
    setTimeout(() => watchAddErrorEl.classList.add("hidden"), 4000);
  }

  function createWatchCard(item) {
    const card = document.createElement("div");
    card.className = "watch-card";
    card.dataset.assetId = item.assetId;

    // Name link
    const info = document.createElement("div");
    info.className = "watch-info";

    const nameLink = document.createElement("a");
    nameLink.className = "watch-name";
    nameLink.href = `https://www.roblox.com/catalog/${item.assetId}`;
    nameLink.target = "_blank";
    nameLink.title = item.name;
    nameLink.textContent = item.name;
    info.appendChild(nameLink);

    // Details row: quantity + price
    const details = document.createElement("div");
    details.className = "watch-details";

    const qty = document.createElement("span");
    qty.className = "watch-qty";
    if (item.quantityLeft != null && item.totalQuantity != null) {
      if (item.quantityLeft === 0) {
        qty.textContent = "Sold out";
        qty.classList.add("sold-out");
      } else {
        qty.textContent = `${item.quantityLeft.toLocaleString()} / ${item.totalQuantity.toLocaleString()} left`;
      }
    } else {
      qty.textContent = "Qty unknown";
      qty.style.color = "#666";
    }
    details.appendChild(qty);

    const price = document.createElement("span");
    price.className = "watch-price";
    if (item.lowestPrice) {
      price.textContent = `R$ ${item.lowestPrice.toLocaleString()}`;
    } else if (item.price) {
      price.textContent = `R$ ${item.price.toLocaleString()}`;
    }
    details.appendChild(price);

    info.appendChild(details);
    card.appendChild(info);

    // Actions container (Add to Sell + Remove)
    const actions = document.createElement("div");
    actions.className = "watch-actions";

    // Add to Sell button
    const addToSellBtn = document.createElement("button");
    addToSellBtn.className = "watch-add-sell-btn";
    addToSellBtn.title = "Add to Sell list";
    addToSellBtn.textContent = "+Sell";
    addToSellBtn.addEventListener("click", async () => {
      addToSellBtn.disabled = true;
      addToSellBtn.textContent = "...";

      try {
        const response = await chrome.runtime.sendMessage({
          type: "ADD_ITEM",
          assetId: item.assetId,
        });

        if (response.error) {
          // Check if it's already in the sell list
          if (response.error.toLowerCase().includes("already")) {
            addToSellBtn.textContent = "Added";
            addToSellBtn.classList.add("added");
          } else {
            addToSellBtn.textContent = "Error";
            setTimeout(() => {
              addToSellBtn.textContent = "+Sell";
              addToSellBtn.disabled = false;
            }, 2000);
          }
          return;
        }

        showToast(`${item.name} added to Sell list`);
        addToSellBtn.textContent = "Added";
        addToSellBtn.classList.add("added");
      } catch (err) {
        addToSellBtn.textContent = "+Sell";
        addToSellBtn.disabled = false;
      }
    });
    actions.appendChild(addToSellBtn);

    // Remove button
    const removeBtn = document.createElement("button");
    removeBtn.className = "watch-remove";
    removeBtn.title = "Remove item";
    removeBtn.innerHTML = "&times;";
    removeBtn.addEventListener("click", async () => {
      const confirmed = await showConfirm(`Are you sure you want to remove ${item.name} from the watch list?`);
      if (confirmed) removeWatchItem(item.assetId, card);
    });
    actions.appendChild(removeBtn);

    card.appendChild(actions);

    return card;
  }

  function renderWatchItems(items) {
    if (items.length === 0) {
      showWatchState("empty");
      return;
    }

    showWatchState("items");
    watchItemListEl.innerHTML = "";

    const countEl = document.createElement("div");
    countEl.className = "item-count";
    countEl.textContent = `${items.length} item${items.length !== 1 ? "s" : ""}`;
    watchItemListEl.appendChild(countEl);

    for (const item of items) {
      watchItemListEl.appendChild(createWatchCard(item));
    }
  }

  async function loadWatchItems(forceRefresh = false) {
    showWatchState("loading");

    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_WATCH_ITEMS" });

      if (response.error) {
        showWatchState("error");
        watchErrorMessageEl.textContent = response.error;
        return;
      }

      renderWatchItems(response.items);
    } catch (err) {
      showWatchState("error");
      watchErrorMessageEl.textContent = `Error: ${err.message}`;
    }
  }

  async function addWatchItem() {
    const raw = watchAssetInput.value;
    const assetId = parseAssetId(raw);

    if (!assetId) {
      showWatchAddError("Enter a valid asset ID or Roblox catalog URL.");
      return;
    }

    watchAddBtn.disabled = true;
    watchAddErrorEl.classList.add("hidden");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "ADD_WATCH_ITEM",
        assetId,
      });

      watchAddBtn.disabled = false;

      if (response.error) {
        showWatchAddError(response.error);
        return;
      }

      watchAssetInput.value = "";

      if (!watchEmptyEl.classList.contains("hidden")) {
        showWatchState("items");
        watchItemListEl.innerHTML = "";
        const countEl = document.createElement("div");
        countEl.className = "item-count";
        countEl.textContent = "1 item";
        watchItemListEl.appendChild(countEl);
      }

      const countEl = watchItemListEl.querySelector(".item-count");
      const cards = watchItemListEl.querySelectorAll(".watch-card");
      if (countEl) {
        const newCount = cards.length + 1;
        countEl.textContent = `${newCount} item${newCount !== 1 ? "s" : ""}`;
      }

      watchItemListEl.appendChild(createWatchCard(response.item));
    } catch (err) {
      watchAddBtn.disabled = false;
      showWatchAddError(`Error: ${err.message}`);
    }
  }

  async function removeWatchItem(assetId, cardEl) {
    cardEl.style.opacity = "0.5";

    try {
      const response = await chrome.runtime.sendMessage({
        type: "REMOVE_WATCH_ITEM",
        assetId,
      });

      if (response.error) {
        cardEl.style.opacity = "1";
        return;
      }

      cardEl.remove();

      const remaining = watchItemListEl.querySelectorAll(".watch-card");
      if (remaining.length === 0) {
        showWatchState("empty");
      } else {
        const countEl = watchItemListEl.querySelector(".item-count");
        if (countEl) {
          countEl.textContent = `${remaining.length} item${remaining.length !== 1 ? "s" : ""}`;
        }
      }
    } catch (err) {
      cardEl.style.opacity = "1";
    }
  }

  watchAddBtn.addEventListener("click", addWatchItem);
  watchAssetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addWatchItem();
  });

  loadItems();
  checkPending2FA();
});
