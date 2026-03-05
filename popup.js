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

    let priceEditHtml = "";
    if (canSell) {
      priceEditHtml = `
        <div class="item-price-row">
          <input type="number" class="price-input" min="1" placeholder="${activeInstance.resalePrice || "Price"}" value="${activeInstance.resalePrice || ""}">
          <button class="price-save-btn">Set Price</button>
        </div>
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

    btnEl.disabled = true;
    statusEl.textContent = "Updating...";
    statusEl.className = "price-status";
    statusEl.classList.remove("hidden");

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
        // Show 2FA input
        show2FAPrompt(response, price, statusEl, btnEl, cardEl);
        return;
      } else {
        onPriceUpdateSuccess(price, statusEl, cardEl);
      }
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = "price-status error";
    }

    btnEl.disabled = false;
  }

  function onPriceUpdateSuccess(price, statusEl, cardEl) {
    statusEl.textContent = "Price updated!";
    statusEl.className = "price-status success";

    const saleStateEl = cardEl.querySelector(".item-sale-state");
    if (saleStateEl) {
      saleStateEl.textContent = `Listed: R$ ${formatPrice(price)}`;
      saleStateEl.className = "item-sale-state on-sale";
    }
  }

  function show2FAPrompt(challengeData, price, statusEl, btnEl, cardEl) {
    statusEl.className = "price-status";
    statusEl.classList.remove("hidden");
    statusEl.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.className = "twofa-prompt";
    wrapper.innerHTML = `
      <div class="twofa-label">Enter 2FA code:</div>
      <div class="twofa-row">
        <input type="text" class="twofa-input" maxlength="6" placeholder="000000" inputmode="numeric" autocomplete="one-time-code">
        <button class="twofa-submit-btn">Verify</button>
      </div>
    `;

    statusEl.appendChild(wrapper);

    const codeInput = wrapper.querySelector(".twofa-input");
    const submitBtn = wrapper.querySelector(".twofa-submit-btn");

    codeInput.focus();

    async function submit2FA() {
      const code = codeInput.value.trim();
      if (!/^\d{6}$/.test(code)) {
        statusEl.innerHTML = "";
        statusEl.textContent = "Enter a 6-digit code";
        statusEl.className = "price-status error";
        btnEl.disabled = false;
        return;
      }

      submitBtn.disabled = true;
      codeInput.disabled = true;

      try {
        const response = await chrome.runtime.sendMessage({
          type: "VERIFY_2FA",
          challengeId: challengeData.challengeId,
          challengeMetadata: challengeData.challengeMetadata,
          code,
          userId: currentUserId,
          retryInfo: challengeData.retryInfo,
        });

        statusEl.innerHTML = "";

        if (response.error) {
          statusEl.textContent = response.error;
          statusEl.className = "price-status error";
        } else {
          onPriceUpdateSuccess(price, statusEl, cardEl);
        }
      } catch (err) {
        statusEl.innerHTML = "";
        statusEl.textContent = err.message;
        statusEl.className = "price-status error";
      }

      btnEl.disabled = false;
    }

    submitBtn.addEventListener("click", submit2FA);
    codeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit2FA();
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
});
