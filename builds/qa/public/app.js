(function () {
  "use strict";

  const state = {
    query: "",
    category: "all",
    sort: "default",
    orderFilter: "all",
    editingId: null,
    categories: [],
    canEdit: false,
    lastCategoryId: null
  };

  const ORDER_TRACKING_ID = "order-tracking";
  const ORDER_LABELS = { to_order: "Need to order", completed: "Completed" };
  /* Product photos are cropped to the same frame as the catalogue cards, so
     portrait and landscape phone photos never stretch or leave awkward gaps. */
  const PRODUCT_IMAGE_ASPECT = 4 / 3;
  const PRODUCT_IMAGE_MAX_WIDTH = 1200;

  const searchInput = document.getElementById("search-input");
  const clearButton = document.getElementById("clear-button");
  const categoryNav = document.getElementById("category-nav");
  const materialsRoot = document.getElementById("materials-root");
  const resultCount = document.getElementById("result-count");
  const emptyState = document.getElementById("empty-state");
  const sortSelect = document.getElementById("sort-select");
  const statItems = document.getElementById("stat-items");
  const statCategories = document.getElementById("stat-categories");
  const dialog = document.getElementById("item-dialog");
  const form = document.getElementById("item-form");
  const categorySelect = document.getElementById("item-category");
  const formError = document.getElementById("form-error");
  const imageInput = document.getElementById("item-image");
  const imagePreview = document.getElementById("item-image-preview");
  const imageEmpty = document.getElementById("item-image-empty");
  const removeImageButton = document.getElementById("remove-item-image");
  const addItemButton = document.getElementById("add-item-button");
  const deleteItemButton = document.getElementById("delete-item-button");
  const statusBanner = document.getElementById("status-banner");

  let selectedImageBlob = null;
  let removeExistingImage = false;
  let previewUrl = null;
  let statusTimer = null;

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  function showStatus(message, kind) {
    statusBanner.textContent = message;
    statusBanner.className = `status-banner status-${kind || "info"}`;
    statusBanner.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { statusBanner.hidden = true; }, 5000);
  }

  function allItems() {
    return state.categories.reduce((sum, category) => sum + category.items.length, 0);
  }

  function updateStats() {
    statItems.textContent = allItems().toLocaleString("en-IN");
    statCategories.textContent = state.categories.length.toLocaleString("en-IN");
  }

  function formatPrice(price) {
    if (price === null || price === undefined || price === "") return '<span class="muted">—</span>';
    return Number(price).toLocaleString("en-IN");
  }

  function tokenize(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  }

  function itemMatchesQuery(item, categoryName, query) {
    if (!query) return true;
    const queryTokens = tokenize(query);
    const haystack = tokenize(
      [item.product, item.size, item.unit, item.notes, item.price, categoryName].filter(Boolean).join(" ")
    );
    return queryTokens.every((token) => haystack.some((word) => word.startsWith(token)));
  }

  function getVisibleCategories() {
    const query = state.query.trim().toLowerCase();
    return state.categories
      .filter((category) => state.category === "all" || category.id === state.category)
      .map((category) => ({
        ...category,
        items: category.items.filter((item) => {
          if (!itemMatchesQuery(item, category.name, query)) return false;
          // Status filter applies inside the Order Tracking category only.
          if (category.id === ORDER_TRACKING_ID && state.orderFilter !== "all") {
            return item.orderStatus === state.orderFilter;
          }
          return true;
        })
      }))
      .filter((category) => category.items.length > 0);
  }

  function updateActiveChip() {
    categoryNav.querySelectorAll(".category-chip").forEach((chip) => {
      const active = chip.dataset.category === state.category;
      chip.classList.toggle("is-active", active);
      chip.setAttribute("aria-pressed", String(active));
    });
  }

  function renderCategoryNav() {
    const total = allItems();
    const chips = [
      `<button type="button" class="category-chip" data-category="all" aria-pressed="false">All <span class="chip-count">${total}</span></button>`,
      ...state.categories.map((category) =>
        `<button type="button" class="category-chip" data-category="${escapeHtml(category.id)}" aria-pressed="false">${escapeHtml(category.name)} <span class="chip-count">${category.items.length}</span></button>`)
    ];
    categoryNav.innerHTML = chips.join("");
    updateActiveChip();
    if (state.canEdit) {
      categorySelect.innerHTML = state.categories.map((category) =>
        `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`).join("");
    }
  }

  function findItem(itemId) {
    for (const category of state.categories) {
      const item = category.items.find((entry) => entry.id === itemId);
      if (item) return { category, item };
    }
    return null;
  }

  function attachImageFallbacks() {
    materialsRoot.querySelectorAll("img.product-image[data-fallback]").forEach((img) => {
      img.addEventListener("error", () => {
        const placeholder = document.createElement("div");
        placeholder.className = "product-image-placeholder";
        const icon = document.createElement("span");
        icon.className = "placeholder-icon";
        const label = document.createElement("span");
        label.textContent = "No photo";
        placeholder.append(icon, label);
        img.replaceWith(placeholder);
      }, { once: true });
    });
  }

  function renderItems() {
    const visibleCategories = getVisibleCategories();
    const visibleCount = visibleCategories.reduce((sum, category) => sum + category.items.length, 0);
    resultCount.textContent = `Showing ${visibleCount} of ${allItems()} materials`;
    emptyState.hidden = visibleCount !== 0;
    materialsRoot.hidden = visibleCount === 0;
    if (!visibleCount) {
      materialsRoot.innerHTML = "";
      return;
    }

    materialsRoot.innerHTML = visibleCategories.map((category) => {
      const items = [...category.items];
      if (state.sort === "price-low") {
        items.sort((a, b) => (a.price == null || a.price === "" ? Infinity : Number(a.price)) - (b.price == null || b.price === "" ? Infinity : Number(b.price)));
      }
      if (state.sort === "price-high") {
        items.sort((a, b) => (b.price == null || b.price === "" ? -Infinity : Number(b.price)) - (a.price == null || a.price === "" ? -Infinity : Number(a.price)));
      }
      if (state.sort === "name") items.sort((a, b) => a.product.localeCompare(b.product));

      const cards = items.map((item) => {
        const picture = item.imageId
          ? `<img class="product-image" data-fallback src="/api/images/${encodeURIComponent(item.imageId)}" alt="${escapeHtml(item.product)} photo" loading="lazy">`
          : `<div class="product-image-placeholder"><span class="placeholder-icon"></span><span>No photo</span></div>`;
        const price = item.price === null || item.price === undefined || item.price === ""
          ? '<span class="price-not-set">Price not set</span>'
          : `<span class="currency">₹</span>${formatPrice(item.price)}<span class="price-unit">${item.unit ? ` / ${escapeHtml(item.unit)}` : ""}</span>`;
        const editButton = state.canEdit
          ? `<button type="button" class="edit-button" data-edit-id="${item.id}" aria-label="Edit ${escapeHtml(item.product)}">Edit item</button>`
          : "";
        const isOrderItem = category.id === ORDER_TRACKING_ID;
        const orderBadge = isOrderItem && item.orderStatus
          ? `<span class="order-badge order-badge--${escapeHtml(item.orderStatus)}">${escapeHtml(ORDER_LABELS[item.orderStatus] || item.orderStatus)}</span>`
          : "";
        const orderToggle = state.canEdit && isOrderItem
          ? `<button type="button" class="edit-button" data-order-toggle="${item.id}" aria-label="Change order status of ${escapeHtml(item.product)}">${item.orderStatus === "completed" ? "Reopen" : "Mark completed"}</button>`
          : "";
        return `<article class="product-card${isOrderItem && item.orderStatus === "completed" ? " is-order-completed" : ""}">
          <div class="product-image-area">${picture}<span class="product-category-tag">${escapeHtml(category.name)}</span></div>
          <div class="product-card-body">
            <h3 class="product-card-title">${escapeHtml(item.product)}</h3>
            <p class="product-spec">${item.size ? escapeHtml(item.size) : "Standard specification"}</p>
            ${item.notes ? `<p class="product-note">${escapeHtml(item.notes)}</p>` : ""}
            <div class="product-price-row"><div class="product-price">${price}</div></div>
            ${orderBadge ? `<div class="product-order-row">${orderBadge}</div>` : ""}
            <div class="product-card-actions">${orderToggle}${orderToggle && editButton ? " " : ""}${editButton}</div>
          </div>
        </article>`;
      }).join("");

      const addButton = state.canEdit
        ? `<button type="button" class="small-add-button" data-add-category="${escapeHtml(category.id)}">+ Add item</button>`
        : "";

      const orderFilterButtons = state.canEdit && category.id === ORDER_TRACKING_ID
        ? `<div class="order-filter" role="group" aria-label="Filter by order status">
            <button type="button" class="order-filter-button${state.orderFilter === "all" ? " is-active" : ""}" data-order-filter="all">All</button>
            <button type="button" class="order-filter-button${state.orderFilter === "to_order" ? " is-active" : ""}" data-order-filter="to_order">Need to order</button>
            <button type="button" class="order-filter-button${state.orderFilter === "completed" ? " is-active" : ""}" data-order-filter="completed">Completed</button>
          </div>`
        : "";

      return `<section class="category-section" id="category-${escapeHtml(category.id)}">
        <div class="section-heading">
          <div><h2>${escapeHtml(category.name)}</h2><p class="section-subtitle">${category.id === ORDER_TRACKING_ID ? "Track completed work and what still needs ordering" : "Find the right material for your project"}</p></div>
          <div class="section-heading-actions">
            ${orderFilterButtons}
            <span class="section-count">${category.items.length} ${category.items.length === 1 ? "item" : "items"}</span>
            ${addButton}
          </div>
        </div>
        <div class="product-grid">${cards}</div>
      </section>`;
    }).join("");

    attachImageFallbacks();
  }

  function updateClearButton() {
    clearButton.hidden = state.query === "" && state.category === "all";
  }

  function render() {
    updateActiveChip();
    updateClearButton();
    renderItems();
  }

  function setImagePreview(url) {
    if (previewUrl && previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    previewUrl = url || null;
    imagePreview.hidden = !url;
    imageEmpty.hidden = !!url;
    removeImageButton.hidden = !url;
    if (url) imagePreview.src = url;
    else imagePreview.removeAttribute("src");
  }

  /* Centre-crop any photo to the 4:3 product frame and downscale it so the
     saved image always matches the catalogue cards. */
  function normalizeProductImage(image) {
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    if (!sourceWidth || !sourceHeight) return null;

    let cropWidth = sourceWidth;
    let cropHeight = sourceHeight;
    if (sourceWidth / sourceHeight > PRODUCT_IMAGE_ASPECT) {
      cropWidth = Math.round(sourceHeight * PRODUCT_IMAGE_ASPECT);
    } else if (sourceWidth / sourceHeight < PRODUCT_IMAGE_ASPECT) {
      cropHeight = Math.round(sourceWidth / PRODUCT_IMAGE_ASPECT);
    }
    const cropX = Math.round((sourceWidth - cropWidth) / 2);
    const cropY = Math.round((sourceHeight - cropHeight) / 2);

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.min(PRODUCT_IMAGE_MAX_WIDTH, cropWidth));
    canvas.height = Math.max(1, Math.round(canvas.width / PRODUCT_IMAGE_ASPECT));
    canvas.getContext("2d").drawImage(
      image,
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );
    return canvas;
  }

  function resetForm() {
    form.reset();
    formError.hidden = true;
    selectedImageBlob = null;
    removeExistingImage = false;
    setImagePreview(null);
  }

  function openEditor(categoryId, itemId) {
    if (!state.canEdit) return;
    resetForm();
    state.editingId = itemId ?? null;
    const isEdit = state.editingId !== null;
    document.getElementById("dialog-title").textContent = isEdit ? "Edit material" : "Add material";
    document.getElementById("save-item-button").textContent = isEdit ? "Save changes" : "Add item";
    deleteItemButton.hidden = !isEdit;

    let found = null;
    if (isEdit) {
      found = findItem(state.editingId);
      if (!found) return;
    }

    function categoryExists(id) {
      return Boolean(id) && [...categorySelect.options].some((option) => option.value === id);
    }

    /* Editing: the dialog opens on the product's current category. Adding:
       the category stays where the user last added/edited a product. */
    const requestedCategoryId =
      (isEdit ? found.item.category_id : null) ||
      categoryId ||
      state.lastCategoryId ||
      (state.category !== "all" ? state.category : null) ||
      (state.categories[0] && state.categories[0].id);
    categorySelect.value = categoryExists(requestedCategoryId) ? requestedCategoryId : "";

    const orderStatusField = document.getElementById("order-status-field");
    const orderStatusSelect = document.getElementById("item-order-status");
    orderStatusField.hidden = categorySelect.value !== ORDER_TRACKING_ID;
    orderStatusSelect.value = "to_order";

    if (isEdit) {
      document.getElementById("item-product").value = found.item.product || "";
      document.getElementById("item-size").value = found.item.size || "";
      document.getElementById("item-price").value = found.item.price ?? "";
      document.getElementById("item-unit").value = found.item.unit || "";
      document.getElementById("item-notes").value = found.item.notes || "";
      if (found.item.orderStatus) orderStatusSelect.value = found.item.orderStatus;
      if (found.item.imageId) {
        setImagePreview(`/api/images/${encodeURIComponent(found.item.imageId)}`);
      }
    }
    dialog.showModal();
    document.getElementById("item-product").focus();
  }

  function closeEditor() {
    dialog.close();
    state.editingId = null;
    resetForm();
  }

  async function reloadMaterials() {
    const response = await SessionUI.request("/api/materials");
    if (!response.ok) throw new Error("Could not load materials.");
    const data = await response.json();
    /* Orders now has its own page in the top bar (like Customers/Admin);
       the catalogue shows only the material categories. */
    state.categories = data.categories.filter((category) => category.id !== ORDER_TRACKING_ID);
    state.canEdit = Boolean(data.canEdit);
    addItemButton.hidden = !state.canEdit;
    updateStats();
    renderCategoryNav();
    render();
  }

  async function uploadSelectedImage() {
    if (!selectedImageBlob) return null;
    const formData = new FormData();
    formData.append("image", selectedImageBlob, "product-photo.jpg");
    const response = await SessionUI.request("/api/images", { method: "POST", body: formData });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "The picture could not be uploaded.");
    return data.id;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formError.hidden = true;

    const product = document.getElementById("item-product").value.trim();
    const categoryId = categorySelect.value;
    if (!product || !categoryId) {
      formError.textContent = "Please enter a product name and choose a category.";
      formError.hidden = false;
      return;
    }
    const rawPrice = document.getElementById("item-price").value.trim();
    const payload = {
      categoryId,
      product,
      size: document.getElementById("item-size").value.trim(),
      price: rawPrice === "" ? null : Number(rawPrice),
      unit: document.getElementById("item-unit").value.trim() || null,
      notes: document.getElementById("item-notes").value.trim(),
      imageId: null
    };
    if (categoryId === ORDER_TRACKING_ID) {
      payload.orderStatus = document.getElementById("item-order-status").value;
    }

    const editing = state.editingId !== null;
    if (editing) {
      const found = findItem(state.editingId);
      payload.imageId = removeExistingImage ? null : (found ? found.item.imageId : null);
    }

    const saveButton = document.getElementById("save-item-button");
    saveButton.disabled = true;
    try {
      const uploadedId = await uploadSelectedImage();
      if (uploadedId) payload.imageId = uploadedId;

      const response = await SessionUI.request(
        editing ? `/api/materials/${state.editingId}` : "/api/materials",
        {
          method: editing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "The item could not be saved.");

      closeEditor();
      await reloadMaterials();
      state.category = categoryId;
      state.lastCategoryId = categoryId;
      render();
      showStatus(editing ? "Item updated." : "Item added.", "success");
    } catch (error) {
      formError.textContent = error.message;
      formError.hidden = false;
    } finally {
      saveButton.disabled = false;
    }
  });

  deleteItemButton.addEventListener("click", async () => {
    if (state.editingId === null) return;
    if (!window.confirm("Delete this item permanently?")) return;
    deleteItemButton.disabled = true;
    try {
      const response = await SessionUI.request(`/api/materials/${state.editingId}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "The item could not be deleted.");
      closeEditor();
      await reloadMaterials();
      showStatus("Item deleted.", "success");
    } catch (error) {
      formError.textContent = error.message;
      formError.hidden = false;
    } finally {
      deleteItemButton.disabled = false;
    }
  });

  imageInput.addEventListener("change", () => {
    const file = imageInput.files && imageInput.files[0];
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      formError.textContent = "Please choose a JPG, PNG, or WEBP image.";
      formError.hidden = false;
      imageInput.value = "";
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      formError.textContent = "That image is too large. Choose a file under 15 MB.";
      formError.hidden = false;
      imageInput.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const canvas = normalizeProductImage(image);
        if (!canvas) {
          formError.textContent = "That image could not be read. Try another file.";
          formError.hidden = false;
          return;
        }
        canvas.toBlob((blob) => {
          if (!blob) return;
          selectedImageBlob = blob;
          removeExistingImage = false;
          setImagePreview(URL.createObjectURL(blob));
        }, "image/jpeg", 0.82);
      };
      image.onerror = () => {
        formError.textContent = "That image could not be read. Try another file.";
        formError.hidden = false;
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  removeImageButton.addEventListener("click", () => {
    selectedImageBlob = null;
    removeExistingImage = true;
    imageInput.value = "";
    setImagePreview(null);
  });

  categoryNav.addEventListener("click", (event) => {
    const chip = event.target.closest(".category-chip");
    if (!chip) return;
    state.category = chip.dataset.category;
    render();
  });

  categorySelect.addEventListener("change", () => {
    const orderStatusField = document.getElementById("order-status-field");
    if (orderStatusField) orderStatusField.hidden = categorySelect.value !== ORDER_TRACKING_ID;
  });

  materialsRoot.addEventListener("click", async (event) => {
    const edit = event.target.closest("[data-edit-id]");
    const add = event.target.closest("[data-add-category]");
    const toggle = event.target.closest("[data-order-toggle]");
    const filterButton = event.target.closest("[data-order-filter]");
    if (edit) openEditor(null, Number(edit.dataset.editId));
    if (add) {
      state.lastCategoryId = add.dataset.addCategory;
      openEditor(add.dataset.addCategory);
    }
    if (filterButton) {
      state.orderFilter = filterButton.dataset.orderFilter;
      render();
    }
    if (toggle) {
      toggle.disabled = true;
      try {
        const response = await SessionUI.request(`/api/materials/${toggle.dataset.orderToggle}/order-status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not update the order status.");
        await reloadMaterials();
        showStatus(data.orderStatus === "completed" ? "Marked as completed." : "Marked as needing to order.", "success");
      } catch (error) {
        showStatus(error.message, "error");
        toggle.disabled = false;
      }
    }
  });

  addItemButton.addEventListener("click", () => {
    const addCategory = state.category !== "all" ? state.category : state.categories[0] && state.categories[0].id;
    state.lastCategoryId = addCategory;
    openEditor(addCategory);
  });

  document.getElementById("close-dialog").addEventListener("click", closeEditor);
  document.getElementById("cancel-dialog").addEventListener("click", closeEditor);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeEditor();
  });

  searchInput.addEventListener("input", () => {
    state.query = searchInput.value;
    render();
  });

  clearButton.addEventListener("click", () => {
    state.query = "";
    state.category = "all";
    searchInput.value = "";
    render();
    searchInput.focus();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.activeElement === searchInput) {
      searchInput.value = "";
      state.query = "";
      render();
    }
  });

  sortSelect.addEventListener("change", () => {
    state.sort = sortSelect.value;
    renderItems();
  });

  (async function init() {
    try {
      const session = await SessionUI.ready();
      if (!session || !session.authenticated) return;
      await reloadMaterials();
    } catch (error) {
      showStatus(error.message || "Could not load the catalogue.", "error");
      resultCount.textContent = "Could not load materials.";
    }
  })();
})();
