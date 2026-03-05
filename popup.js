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

  let autolistOpen = false;

  autolistToggle.addEventListener("click", () => {
    autolistOpen = !autolistOpen;
    autolistBody.classList.toggle("hidden", !autolistOpen);
    autolistArrow.innerHTML = autolistOpen ? "&#9650;" : "&#9660;";
  });

  autolistStartBtn.addEventListener("click", async () => {
    const settings = {
      enabled: true,
      intervalMin: Math.max(3, Number(autolistInterval.value) || 5),
      undercutAmount: Math.max(1, Number(autolistUndercut.value) || 1),
      priceFloors: {},
      listCounts: {},
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
    const urlMatch = trimmed.match(/roblox\.com\/catalog\/(\d+)/i);
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
      bestSellerHtml = `<div class="item-best-seller${item.isBestPrice ? " is-you" : ""}">Best: R$ ${formatPrice(item.bestSeller.price)} by ${sellerLink}${item.isBestPrice ? " (You!)" : ""}</div>`;
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

    let priceEditHtml = "";
    if (canSell) {
      priceEditHtml = `
        <div class="item-price-row">
          <input type="number" class="price-input" min="1" placeholder="${activeInstance.resalePrice || "Price"}" value="${activeInstance.resalePrice || ""}">
          <button class="price-save-btn">Set Price</button>
        </div>
        ${listCountHtml}
        ${floorHtml}
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

    card.querySelector(".item-remove").addEventListener("click", () => {
      removeItem(item.assetId, card);
    });

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

    // Multi-copy listing
    if (copyCount > 1 && item.allInstances && item.allInstances.length >= 2) {
      const instancesToList = item.allInstances.slice(0, copyCount);
      statusEl.textContent = `Listing ${instancesToList.length} copies...`;

      try {
        const response = await chrome.runtime.sendMessage({
          type: "UPDATE_MULTI_PRICE",
          collectibleItemId: item.collectibleItemId,
          instances: instancesToList,
          price,
          userId: currentUserId,
        });

        if (response.twoFA) {
          const msg = response.listed > 0 ? `${response.listed} listed, then 2FA required` : "2FA required";
          show2FAModal(response.challengeData, price, statusEl, btnEl, cardEl);
          if (response.listed > 0) {
            showToast(`${response.listed} cop${response.listed !== 1 ? "ies" : "y"} listed!`);
          }
          return;
        }

        const totalMsg = `${response.listed} cop${response.listed !== 1 ? "ies" : "y"} listed!`;
        showToast(totalMsg);
        statusEl.textContent = "";
        statusEl.classList.add("hidden");

        const saleStateEl = cardEl.querySelector(".item-sale-state");
        if (saleStateEl) {
          saleStateEl.textContent = `Listed: R$ ${formatPrice(price)}`;
          saleStateEl.className = "item-sale-state on-sale";
        }
      } catch (err) {
        statusEl.textContent = err.message;
        statusEl.className = "price-status error";
      }

      btnEl.disabled = false;
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

  // --- Global 2FA Modal & Success Toast ---
  const modal = document.getElementById("twofa-modal");
  const modalItemName = document.getElementById("modal-item-name");
  const modalDesc = document.getElementById("modal-desc");
  const modalInput = document.getElementById("modal-2fa-input");
  const modalSubmit = document.getElementById("modal-2fa-submit");
  const modalError = document.getElementById("modal-2fa-error");
  const modalSkip = document.getElementById("modal-2fa-skip");
  const modalCount = document.getElementById("modal-2fa-count");
  const toast = document.getElementById("success-toast");
  const toastMsg = document.getElementById("toast-msg");

  let pendingQueue = [];
  let currentPendingIdx = 0;
  let modalResolveCallback = null; // for manual price update flow

  function showToast(msg) {
    toastMsg.textContent = msg;
    toast.classList.remove("hidden");
    setTimeout(() => toast.classList.add("hidden"), 3000);
  }

  function openModal(opts) {
    // opts: { itemName, desc, onSubmit(code), onSkip(), count }
    modalItemName.textContent = opts.itemName || "";
    modalDesc.textContent = opts.desc || "";
    modalInput.value = "";
    modalInput.disabled = false;
    modalSubmit.disabled = false;
    modalError.classList.add("hidden");
    modalCount.textContent = opts.count || "";
    modal.classList.remove("hidden");
    setTimeout(() => modalInput.focus(), 50);

    // Remove old listeners by cloning
    const newSubmit = modalSubmit.cloneNode(true);
    modalSubmit.parentNode.replaceChild(newSubmit, modalSubmit);
    const newSkip = modalSkip.cloneNode(true);
    modalSkip.parentNode.replaceChild(newSkip, modalSkip);
    const newInput = modalInput.cloneNode(true);
    modalInput.parentNode.replaceChild(newInput, modalInput);

    // Re-grab references after clone
    const submitBtn = document.getElementById("modal-2fa-submit");
    const skipBtn = document.getElementById("modal-2fa-skip");
    const inputEl = document.getElementById("modal-2fa-input");
    const errorEl = document.getElementById("modal-2fa-error");

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

  // For manual price update — show modal instead of inline
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

        if (response.error) {
          throw new Error(response.error);
        }

        closeModal();
        showToast("Listed Successfully!");

        // Update the card UI
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

  function renderItems(items) {
    if (items.length === 0) {
      showState("empty");
      return;
    }

    showState("items");
    itemListEl.innerHTML = "";

    const countEl = document.createElement("div");
    countEl.className = "item-count";
    countEl.textContent = `${items.length} item${items.length !== 1 ? "s" : ""}`;
    itemListEl.appendChild(countEl);

    for (const item of items) {
      itemListEl.appendChild(createItemCard(item));
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

    cardEl.remove();

    const remaining = itemListEl.querySelectorAll(".item-card");
    if (remaining.length === 0) {
      showState("empty");
    } else {
      const countEl = itemListEl.querySelector(".item-count");
      if (countEl) {
        countEl.textContent = `${remaining.length} item${remaining.length !== 1 ? "s" : ""}`;
      }
    }
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

    if (!emptyEl.classList.contains("hidden")) {
      showState("items");
      itemListEl.innerHTML = "";
      const countEl = document.createElement("div");
      countEl.className = "item-count";
      countEl.textContent = "1 item";
      itemListEl.appendChild(countEl);
    }

    const countEl = itemListEl.querySelector(".item-count");
    const cards = itemListEl.querySelectorAll(".item-card");
    if (countEl) {
      const newCount = cards.length + 1;
      countEl.textContent = `${newCount} item${newCount !== 1 ? "s" : ""}`;
    }

    itemListEl.appendChild(createItemCard(response.item));
  }

  async function loadItems(forceRefresh = false) {
    showState("loading");

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

      renderItems(response.items);
    } catch (err) {
      showState("error");
      errorMessageEl.textContent = `Error: ${err.message}`;
    }
  }

  addBtn.addEventListener("click", addItem);
  assetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addItem();
  });
  refreshBtn.addEventListener("click", () => loadItems(true));

  loadItems();
  checkPending2FA();
});
