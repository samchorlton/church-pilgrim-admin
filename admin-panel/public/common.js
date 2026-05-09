(function () {
  const KNOWN_THEME_TAGS = ["ancient-origins", "medieval", "reformation", "revival-mission", "hidden-gems"];
  const KNOWN_EDITORIAL_STATUSES = ["draft", "review", "live", "archived"];
  const KNOWN_GRADES = ["I", "II*", "II"];
  const richTextEditors = new Map();

  async function fetchJson(url, init) {
    const res = await fetch(url, { credentials: "include", ...(init || {}) });
    const payload = await res.json().catch(() => ({}));
    if (res.status === 401) {
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
      throw new Error("Unauthorized. Please sign in again.");
    }
    if (!res.ok) throw new Error(payload.error || `Request failed: ${res.status}`);
    return payload;
  }

  function htmlEscape(value) {
    return String(value ?? "").replace(/[<>&]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m]));
  }

  function setMessage(el, message, type) {
    if (!el) return;
    el.textContent = message || "";
    el.className = type === "error" ? "error" : type === "success" ? "success" : "mini";
  }

  function compactObject(value) {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== ""));
  }

  function linesToArray(value) {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function arrayToLines(items) {
    if (!Array.isArray(items)) return "";
    return items.map((item) => String(item ?? "").trim()).filter(Boolean).join("\n");
  }

  function parseOptionalObjectJson(value, label) {
    if (!value) return null;
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${label} must be valid JSON.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object.`);
    }
    return parsed;
  }

  function parseTimelineRows(value) {
    if (!value) return [];
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        const delimiterIndex = line.indexOf("|");
        if (delimiterIndex < 0) throw new Error(`Timeline line ${index + 1} must use "YEAR | EVENT".`);
        const year = line.slice(0, delimiterIndex).trim();
        const event = line.slice(delimiterIndex + 1).trim();
        if (!year || !event) throw new Error(`Timeline line ${index + 1} must include both year and event.`);
        return { year, event };
      });
  }

  function encodeEscapedNewlines(value) {
    if (value === null || value === undefined) return value;
    return String(value).replace(/\r\n|\r|\n/g, "\\n");
  }

  function decodeEscapedNewlines(value) {
    if (value === null || value === undefined) return value;
    return String(value).replace(/\\n/g, "\n");
  }

  function convertNewlinesToBr(value) {
    if (value === null || value === undefined) return value;
    return String(value)
      .replace(/\\n/g, "\n")
      .replace(/\r\n|\r|\n/g, "<br>");
  }

  function sanitizeRichHtml(value) {
    return String(value ?? "")
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
      .replace(/\son\w+="[^"]*"/gi, "")
      .replace(/\son\w+='[^']*'/gi, "")
      .replace(/javascript:/gi, "");
  }

  function normalizeHtmlForStorage(value) {
    return String(value ?? "")
      .replace(/<\s*div\b[^>]*>/gi, "")
      .replace(/<\s*\/div\s*>/gi, "<br>")
      .replace(/<\s*p\b[^>]*>/gi, "")
      .replace(/<\s*\/p\s*>/gi, "<br><br>")
      .replace(/(<br>\s*){3,}/gi, "<br><br>")
      .trim();
  }

  function normalizeEditorHtml(value) {
    return sanitizeRichHtml(String(value ?? "").trim())
      .replace(/\\n/g, "\n")
      .replace(/\r\n|\r|\n/g, "<br>")
      .replace(/<(div|p)><br><\/\1>/g, "")
      .replace(/<\s*\/div\s*>/gi, "<br>")
      .replace(/<\s*div\b[^>]*>/gi, "")
      .trim();
  }

  function createToolbarButton(label, command, value = null) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rt-btn";
    button.textContent = label;
    button.addEventListener("click", () => {
      const commandValue = typeof value === "function" ? value() : value;
      if (command === "createLink" && !commandValue) return;
      document.execCommand(command, false, commandValue);
    });
    return button;
  }

  function initRichTextEditor(textareaId) {
    const textarea = document.getElementById(textareaId);
    if (!textarea || textarea.dataset.richTextReady === "1") return;

    const wrapper = document.createElement("div");
    wrapper.className = "rt-wrap span-2";
    const toolbar = document.createElement("div");
    toolbar.className = "rt-toolbar";
    const editor = document.createElement("div");
    editor.className = "rt-editor";
    editor.contentEditable = "true";
    editor.dataset.targetTextareaId = textareaId;

    toolbar.appendChild(createToolbarButton("B", "bold"));
    toolbar.appendChild(createToolbarButton("I", "italic"));
    toolbar.appendChild(createToolbarButton("H3", "formatBlock", "H3"));
    toolbar.appendChild(createToolbarButton("UL", "insertUnorderedList"));
    toolbar.appendChild(createToolbarButton("OL", "insertOrderedList"));
    toolbar.appendChild(createToolbarButton("Link", "createLink", () => prompt("Enter URL")));
    toolbar.appendChild(createToolbarButton("Clear", "removeFormat"));

    const syncToTextarea = () => {
      textarea.value = normalizeHtmlForStorage(normalizeEditorHtml(editor.innerHTML));
    };

    editor.addEventListener("input", syncToTextarea);
    editor.addEventListener("blur", syncToTextarea);
    editor.addEventListener("paste", (event) => {
      event.preventDefault();
      const html = event.clipboardData?.getData("text/html");
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (html) {
        document.execCommand("insertHTML", false, sanitizeRichHtml(html));
      } else {
        document.execCommand("insertText", false, text);
      }
      syncToTextarea();
    });

    wrapper.appendChild(toolbar);
    wrapper.appendChild(editor);
    textarea.style.display = "none";
    textarea.insertAdjacentElement("afterend", wrapper);
    textarea.dataset.richTextReady = "1";

    richTextEditors.set(textareaId, {
      setValue(value) {
        const html = normalizeEditorHtml(decodeEscapedNewlines(value) ?? "");
        editor.innerHTML = html || "";
        textarea.value = html;
      },
      getValue() {
        return normalizeHtmlForStorage(normalizeEditorHtml(textarea.value));
      },
    });
  }

  function setupRichTextEditors(editorIds) {
    editorIds.forEach((id) => initRichTextEditor(id));
  }

  function getFieldValue(id) {
    const editorApi = richTextEditors.get(id);
    if (editorApi) return editorApi.getValue().trim();
    const el = document.getElementById(id);
    return el ? el.value.trim() : "";
  }

  function setFieldValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value ?? "";
    const editorApi = richTextEditors.get(id);
    if (editorApi) editorApi.setValue(value ?? "");
  }

  function timelineRowsToText(items) {
    if (!Array.isArray(items)) return "";
    return items
      .map((item) => {
        const year = String(item?.year ?? "").trim();
        const event = String(item?.event ?? "").trim();
        if (!year && !event) return null;
        return `${year} | ${event}`.trim();
      })
      .filter(Boolean)
      .join("\n");
  }

  function getMultiSelectValues(selectId) {
    const select = document.getElementById(selectId);
    return Array.from(select?.selectedOptions || []).map((option) => option.value).filter(Boolean);
  }

  function setMultiSelectValues(selectId, values) {
    const set = new Set((values || []).map((item) => String(item).trim()).filter(Boolean));
    const select = document.getElementById(selectId);
    Array.from(select?.options || []).forEach((option) => {
      option.selected = set.has(option.value);
    });
  }

  function getCurrentUrlParams() {
    return new URLSearchParams(window.location.search || "");
  }

  function updateUrlParams(updates) {
    const params = getCurrentUrlParams();
    Object.entries(updates || {}).forEach(([key, value]) => {
      if (value === null || value === undefined || String(value).trim() === "") {
        params.delete(key);
        return;
      }
      params.set(key, String(value));
    });

    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`;
    window.history.replaceState({}, "", nextUrl);
  }

  function ensureAuthHeaderActions() {
    const nav = document.querySelector(".top-nav");
    if (!nav || document.getElementById("admin-logout-btn")) return;
    const button = document.createElement("button");
    button.id = "admin-logout-btn";
    button.className = "nav-signout";
    button.type = "button";
    button.textContent = "Sign Out";
    button.addEventListener("click", async () => {
      try {
        await fetchJson("/api/auth/logout", { method: "POST" });
      } catch {
        // noop
      } finally {
        window.location.href = "/login";
      }
    });
    nav.appendChild(button);
  }

  function initTabNavigation(containerId, panelPrefix, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const buttons = Array.from(container.querySelectorAll("[data-tab-target]"));
    if (!buttons.length) return;

    const showTab = (target) => {
      buttons.forEach((button) => {
        const isActive = button.getAttribute("data-tab-target") === target;
        button.classList.toggle("active", isActive);
        button.setAttribute("aria-selected", isActive ? "true" : "false");
      });

      document.querySelectorAll(`[id^="${panelPrefix}"]`).forEach((panel) => {
        panel.classList.toggle("active", panel.id === `${panelPrefix}${target}`);
      });
      if (typeof options.onChange === "function") {
        options.onChange(target);
      }
    };

    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        const target = button.getAttribute("data-tab-target");
        if (!target) return;
        showTab(target);
      });
    });

    const requestedInitial = String(options.initialTarget || "").trim();
    const initialTarget =
      (requestedInitial &&
      buttons.some((button) => button.getAttribute("data-tab-target") === requestedInitial)
        ? requestedInitial
        : null) ||
      buttons.find((button) => button.classList.contains("active"))?.getAttribute("data-tab-target") ||
      buttons[0].getAttribute("data-tab-target");
    if (initialTarget) showTab(initialTarget);

    return {
      showTab,
    };
  }

  function initModerationWorkspace(options) {
    const textListEl = document.getElementById(options.textListId);
    const imageListEl = document.getElementById(options.imageListId);
    const audioListEl = document.getElementById(options.audioListId);
    const memoryListEl = document.getElementById(options.memoryListId);
    if (!textListEl || !imageListEl || !audioListEl || !memoryListEl) return null;

    const statusEl = document.getElementById(options.statusId);
    const viewFilterEl = document.getElementById(options.viewFilterId);
    const statusFilterEl = document.getElementById(options.statusFilterId);
    const memoryTypeFilterEl = document.getElementById(options.memoryTypeFilterId);
    const listEntryFilterEl = document.getElementById(options.listEntryFilterId);
    const refreshBtnEl = document.getElementById(options.refreshBtnId);
    let activeListEntryFilter = String(listEntryFilterEl?.value || "").trim();

    async function updateModeration(type, id, status, adminNotes) {
      await fetchJson(`/api/moderation/${type}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          admin_notes: adminNotes || null,
        }),
      });
    }

    function renderEmpty(listEl, label) {
      listEl.innerHTML = `<div class="list-item mini">No ${label} items.</div>`;
    }

    function renderTextItems(items) {
      textListEl.innerHTML = "";
      if (!items.length) {
        renderEmpty(textListEl, "text");
        return;
      }
      items.forEach((item) => {
        const moderationType = item.moderation_type || "text";
        const card = document.createElement("article");
        card.className = "moderation-item";
        card.innerHTML = `
          <h3 class="moderation-title">#${item.id} | ${htmlEscape(item.contribution_type || "text")} | List ${item.list_entry}</h3>
          <p class="moderation-meta">Status: ${htmlEscape(item.status)} | User: ${htmlEscape(item.user_id)} | ${htmlEscape(item.created_at)}</p>
          <div class="moderation-body"><strong>Suggested:</strong><br/>${htmlEscape(item.suggested_content || "").replace(/\n/g, "<br/>")}</div>
          <div class="moderation-body"><strong>Current:</strong><br/>${htmlEscape(item.current_content || "None").replace(/\n/g, "<br/>")}</div>
          ${item.timeline_year ? `<div class="moderation-body"><strong>Timeline year:</strong> ${htmlEscape(item.timeline_year)}</div>` : ""}
          <div class="moderation-actions">
            <textarea data-notes="${item.id}" class="span-2" placeholder="Admin notes">${htmlEscape(item.admin_notes || "")}</textarea>
            <button data-action="approve" data-id="${item.id}" data-type="${moderationType}">Approve</button>
            <button data-action="reject" data-id="${item.id}" data-type="${moderationType}" class="danger">Reject</button>
            <button data-action="pending" data-id="${item.id}" data-type="${moderationType}" class="ghost">Mark Pending</button>
          </div>
        `;
        textListEl.appendChild(card);
      });
    }

    function renderImageItems(items) {
      imageListEl.innerHTML = "";
      if (!items.length) {
        renderEmpty(imageListEl, "image");
        return;
      }
      items.forEach((item) => {
        const card = document.createElement("article");
        card.className = "moderation-item";
        card.innerHTML = `
          <h3 class="moderation-title">#${item.id} | List ${item.list_entry}</h3>
          <p class="moderation-meta">Status: ${htmlEscape(item.status)} | User: ${htmlEscape(item.user_id)} | ${htmlEscape(item.created_at)}</p>
          <img class="moderation-media" src="${htmlEscape(item.image_url)}" alt="Submitted image" />
          <div class="moderation-body"><strong>Caption:</strong> ${htmlEscape(item.image_caption || "None")}</div>
          <div class="moderation-body"><strong>Credit:</strong> ${htmlEscape(item.image_credit || "None")}</div>
          <div class="moderation-body"><a href="${htmlEscape(item.image_url)}" target="_blank" rel="noreferrer">Open image</a></div>
          <div class="moderation-actions">
            <textarea data-notes="${item.id}" class="span-2" placeholder="Admin notes">${htmlEscape(item.admin_notes || "")}</textarea>
            <button data-action="approve" data-id="${item.id}" data-type="image">Approve</button>
            <button data-action="reject" data-id="${item.id}" data-type="image" class="danger">Reject</button>
            <button data-action="pending" data-id="${item.id}" data-type="image" class="ghost">Mark Pending</button>
          </div>
        `;
        imageListEl.appendChild(card);
      });
    }

    function renderAudioItems(items) {
      audioListEl.innerHTML = "";
      if (!items.length) {
        renderEmpty(audioListEl, "audio");
        return;
      }
      items.forEach((item) => {
        const card = document.createElement("article");
        card.className = "moderation-item";
        card.innerHTML = `
          <h3 class="moderation-title">#${item.id} | List ${item.list_entry}</h3>
          <p class="moderation-meta">Status: ${htmlEscape(item.status)} | User: ${htmlEscape(item.user_id)} | ${htmlEscape(item.created_at)}</p>
          <div class="moderation-body"><strong>Title:</strong> ${htmlEscape(item.audio_title || "None")}</div>
          <div class="moderation-body"><strong>Credit:</strong> ${htmlEscape(item.audio_credit || "None")}</div>
          <div class="moderation-body"><strong>File:</strong> ${htmlEscape(item.file_name || "Unknown")} (${htmlEscape(item.mime_type || "unknown")})</div>
          <audio controls style="width:100%; margin-bottom:8px;">
            <source src="${htmlEscape(item.audio_url)}" />
          </audio>
          <div class="moderation-body"><a href="${htmlEscape(item.audio_url)}" target="_blank" rel="noreferrer">Open audio</a></div>
          <div class="moderation-actions">
            <textarea data-notes="${item.id}" class="span-2" placeholder="Admin notes">${htmlEscape(item.admin_notes || "")}</textarea>
            <button data-action="approve" data-id="${item.id}" data-type="audio">Approve</button>
            <button data-action="reject" data-id="${item.id}" data-type="audio" class="danger">Reject</button>
            <button data-action="pending" data-id="${item.id}" data-type="audio" class="ghost">Mark Pending</button>
          </div>
        `;
        audioListEl.appendChild(card);
      });
    }

    function renderMemoryItems(items) {
      memoryListEl.innerHTML = "";
      if (!items.length) {
        renderEmpty(memoryListEl, "memory");
        return;
      }
      items.forEach((item) => {
        const moderationType = item.moderation_type || "memory";
        const kindLabel =
          moderationType === "people" ? "person" : String(item.memory_type || "memory").trim() || "memory";
        const dateLabel = item.event_date
          ? `Event date: ${item.event_date}`
          : item.from_date || item.to_date
            ? `Date range: ${item.from_date || "?"} → ${item.to_date || "?"}`
            : "Date: not provided";
        const titleLabel = String(item.title || "").trim();
        const roleLabel = String(item.role || "").trim();
        const card = document.createElement("article");
        card.className = "moderation-item";
        card.innerHTML = `
          <h3 class="moderation-title">#${item.id} | ${htmlEscape(kindLabel)} | List ${item.list_entry}</h3>
          <p class="moderation-meta">Status: ${htmlEscape(item.status)} | User: ${htmlEscape(item.user_id)} | ${htmlEscape(item.created_at)}</p>
          ${titleLabel ? `<div class="moderation-body"><strong>Title:</strong> ${htmlEscape(titleLabel)}</div>` : ""}
          ${roleLabel ? `<div class="moderation-body"><strong>Role:</strong> ${htmlEscape(roleLabel)}</div>` : ""}
          <div class="moderation-body"><strong>Body:</strong><br/>${htmlEscape(item.body_text || "").replace(/\n/g, "<br/>")}</div>
          <div class="moderation-body"><strong>${htmlEscape(dateLabel)}</strong></div>
          ${item.image_url ? `<img class="moderation-media" src="${htmlEscape(item.image_url)}" alt="Memory image" />` : ""}
          ${item.image_url ? `<div class="moderation-body"><a href="${htmlEscape(item.image_url)}" target="_blank" rel="noreferrer">Open image</a></div>` : ""}
          <div class="moderation-actions">
            <textarea data-notes="${item.id}" class="span-2" placeholder="Admin notes">${htmlEscape(item.admin_notes || "")}</textarea>
            <button data-action="approve" data-id="${item.id}" data-type="${moderationType}">Approve</button>
            <button data-action="reject" data-id="${item.id}" data-type="${moderationType}" class="danger">Reject</button>
            <button data-action="pending" data-id="${item.id}" data-type="${moderationType}" class="ghost">Mark Pending</button>
          </div>
        `;
        memoryListEl.appendChild(card);
      });
    }

    async function loadQueue() {
      const view = String(viewFilterEl?.value || "approvals").trim();
      const status = String(statusFilterEl?.value || "pending").trim();
      const memoryType = String(memoryTypeFilterEl?.value || "").trim();
      const listEntry = String(listEntryFilterEl?.value || activeListEntryFilter || "").trim();
      setMessage(statusEl, "Loading queue...");
      try {
        const qs = new URLSearchParams();
        if (view) qs.set("view", view);
        if (status) qs.set("status", status);
        if (memoryType) qs.set("memory_type", memoryType);
        if (listEntry) qs.set("list_entry", listEntry);
        const data = await fetchJson(`/api/moderation/queue?${qs.toString()}`);
        const textItems = data.text || [];
        const imageItems = data.images || [];
        const audioItems = data.audio || [];
        const memoryItems = data.memories || [];
        renderTextItems(textItems);
        renderImageItems(imageItems);
        renderAudioItems(audioItems);
        renderMemoryItems(memoryItems);
        setMessage(
          statusEl,
          `${textItems.length} text, ${imageItems.length} images, ${audioItems.length} audio, ${memoryItems.length} memories`,
          "success"
        );
      } catch (error) {
        setMessage(statusEl, error.message, "error");
      }
    }

    async function handleActionClick(event) {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const action = button.getAttribute("data-action");
      const id = Number(button.getAttribute("data-id"));
      const type = button.getAttribute("data-type");
      if (!action || !type || !Number.isInteger(id)) return;
      const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "pending";
      const notesEl = button.parentElement?.querySelector(`textarea[data-notes="${id}"]`);
      const notes = notesEl ? notesEl.value.trim() : "";
      try {
        button.disabled = true;
        await updateModeration(type, id, status, notes);
        await loadQueue();
      } catch (error) {
        setMessage(statusEl, error.message, "error");
      } finally {
        button.disabled = false;
      }
    }

    textListEl.addEventListener("click", handleActionClick);
    imageListEl.addEventListener("click", handleActionClick);
    audioListEl.addEventListener("click", handleActionClick);
    memoryListEl.addEventListener("click", handleActionClick);

    refreshBtnEl && (refreshBtnEl.onclick = loadQueue);
    viewFilterEl?.addEventListener("change", loadQueue);
    statusFilterEl?.addEventListener("change", loadQueue);
    memoryTypeFilterEl?.addEventListener("change", loadQueue);
    listEntryFilterEl?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") loadQueue();
    });

    return {
      loadQueue,
      setListEntry(value) {
        activeListEntryFilter = value ? String(value).trim() : "";
        if (!listEntryFilterEl) return;
        listEntryFilterEl.value = activeListEntryFilter;
      },
    };
  }

  async function initProfilesPage() {
    const profileListEl = document.getElementById("profile-list");
    if (!profileListEl) return;
    const pageParams = getCurrentUrlParams();
    const requestedSection = String(pageParams.get("section") || "core").trim();
    const requestedListingIdRaw = String(pageParams.get("listingId") || "").trim();
    const requestedListingId = Number.isInteger(Number(requestedListingIdRaw))
      ? Number(requestedListingIdRaw)
      : null;
    initTabNavigation("profile-tabs", "tab-panel-", {
      initialTarget: requestedSection || "core",
      onChange: (target) => updateUrlParams({ section: target }),
    });

    let selectedProfile = null;
    let profileRows = [];

    const statusEl = document.getElementById("profile-status");
    const messageEl = document.getElementById("profile-message");
    const heroPreviewEl = document.getElementById("p-hero-image-preview");
    const heroLinkEl = document.getElementById("p-hero-image-link");
    const heroFileEl = document.getElementById("p-hero-image-file");
    const planPreviewEl = document.getElementById("p-plan-image-preview");
    const planLinkEl = document.getElementById("p-plan-image-link");
    const planFileEl = document.getElementById("p-plan-image-file");
    const moderationWorkspace = initModerationWorkspace({
      textListId: "profile-mod-text-list",
      imageListId: "profile-mod-image-list",
      audioListId: "profile-mod-audio-list",
      memoryListId: "profile-mod-memory-list",
      statusId: "profile-mod-status",
      viewFilterId: "profile-mod-view-filter",
      statusFilterId: "profile-mod-status-filter",
      memoryTypeFilterId: "profile-mod-memory-type-filter",
      listEntryFilterId: "profile-mod-list-entry-filter",
      refreshBtnId: "profile-mod-refresh-btn",
    });

    const updateHeroPreview = (imageUrl, sourceUrl, sourceLabel) => {
      const cleanImageUrl = String(imageUrl ?? "").trim();
      const cleanSourceUrl = String(sourceUrl ?? "").trim();

      if (heroPreviewEl) {
        if (cleanImageUrl) {
          heroPreviewEl.src = cleanImageUrl;
          heroPreviewEl.style.display = "";
        } else {
          heroPreviewEl.removeAttribute("src");
          heroPreviewEl.style.display = "none";
        }
      }

      if (heroLinkEl) {
        const linkTarget = cleanSourceUrl || cleanImageUrl;
        if (linkTarget) {
          heroLinkEl.href = linkTarget;
          const baseText = cleanSourceUrl ? `Source: ${cleanSourceUrl}` : `Image URL: ${cleanImageUrl}`;
          heroLinkEl.textContent = sourceLabel ? `${baseText} (${sourceLabel})` : baseText;
          heroLinkEl.style.display = "";
        } else {
          heroLinkEl.removeAttribute("href");
          heroLinkEl.textContent = "";
          heroLinkEl.style.display = "none";
        }
      }
    };

    const updatePlanPreview = (imageUrl) => {
      const cleanImageUrl = String(imageUrl ?? "").trim();
      if (planPreviewEl) {
        if (cleanImageUrl) {
          planPreviewEl.src = cleanImageUrl;
          planPreviewEl.style.display = "";
        } else {
          planPreviewEl.removeAttribute("src");
          planPreviewEl.style.display = "none";
        }
      }
      if (planLinkEl) {
        if (cleanImageUrl) {
          planLinkEl.href = cleanImageUrl;
          planLinkEl.textContent = `Plan URL: ${cleanImageUrl}`;
          planLinkEl.style.display = "";
        } else {
          planLinkEl.removeAttribute("href");
          planLinkEl.textContent = "";
          planLinkEl.style.display = "none";
        }
      }
    };

    const fileToBase64 = (file) =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || "");
          const commaIndex = result.indexOf(",");
          if (commaIndex < 0) {
            reject(new Error("Could not read image file."));
            return;
          }
          resolve(result.slice(commaIndex + 1));
        };
        reader.onerror = () => reject(new Error("Could not read image file."));
        reader.readAsDataURL(file);
      });

    setupRichTextEditors([
      "p-summary",
      "p-history",
      "p-architecture",
      "p-supp-source-summary",
      "p-supp-source-history",
      "p-supp-source-details",
      "p-editorial-notes",
      "p-folklore-text",
    ]);

    const profileFormValues = () => {
      const timelineText = getFieldValue("p-timeline-events");
      const timelineEvents = parseTimelineRows(timelineText);
      const reasonsForDesignation = linesToArray(getFieldValue("p-supp-reasons"));
      const selectedTags = getMultiSelectValues("p-tags-select");
      const customTags = linesToArray(getFieldValue("p-tags-custom").replace(/,/g, "\n"));
      const allTags = Array.from(new Set([...selectedTags, ...customTags].map((tag) => String(tag).trim()).filter(Boolean)));
      const selectedStatus = getFieldValue("p-editorial-status");
      const customStatus = getFieldValue("p-editorial-status-custom");
      const active = getFieldValue("p-active-status") || null;
      const selectedGrade = getFieldValue("p-supp-grade");
      const customGrade = getFieldValue("p-supp-grade-custom");
      const heroImageUrl = getFieldValue("p-hero-image-url");
      const heroImageSourceUrl = getFieldValue("p-hero-image-source-url");
      const planUrl = getFieldValue("p-plan-url");
      const heroDateLabel = getFieldValue("p-hero-date-label");

      // Build payload for churches_v2 schema with explicit columns
      const contentBlocks = compactObject({
        history: convertNewlinesToBr(getFieldValue("p-history")) || null,
        architecture: convertNewlinesToBr(getFieldValue("p-architecture")) || null,
      });
      const location = compactObject({
        county: getFieldValue("p-location-county") || null,
        district: getFieldValue("p-location-district") || null,
        parish: getFieldValue("p-location-parish") || null,
      });
      const supplementary = compactObject({
        sourceSummary: convertNewlinesToBr(getFieldValue("p-supp-source-summary")) || null,
        sourceHistory: convertNewlinesToBr(getFieldValue("p-supp-source-history")) || null,
        sourceDetails: convertNewlinesToBr(getFieldValue("p-supp-source-details")) || null,
        reasonsForDesignation: reasonsForDesignation.length ? reasonsForDesignation : null,
        listedDate: getFieldValue("p-supp-listed-date") || null,
        grade: customGrade || selectedGrade || null,
      });
      const extraJson = parseOptionalObjectJson(getFieldValue("p-profile-json-extra"), "Advanced profile_json");

      // Build profile_json for backward compatibility (backend will flatten to explicit columns)
      const profileJson = {
        ...(extraJson || {}),
        ...(Object.keys(contentBlocks).length ? { contentBlocks } : {}),
        ...(Object.keys(location).length ? { location } : {}),
        ...(Object.keys(supplementary).length ? { supplementary } : {}),
        ...(heroImageUrl ? { heroImageUrl } : {}),
        ...(heroImageSourceUrl ? { heroImageSourceUrl } : {}),
      };

      return {
        list_entry: getFieldValue("p-list-entry"),
        title: getFieldValue("p-title"),
        subtitle: getFieldValue("p-subtitle"),
        summary: convertNewlinesToBr(getFieldValue("p-summary")),
        editorial_status: customStatus || selectedStatus || selectedProfile?.editorial_status || "draft",
        editorial_notes: convertNewlinesToBr(getFieldValue("p-editorial-notes")),
        church_website: getFieldValue("p-church-website"),
        current_usage: active !== null ? active : selectedProfile?.current_usage,
        hero_date_label: heroDateLabel, // Backend maps to construction_date
        plan_url: planUrl || null,
        tags: allTags,
        timeline_events: timelineEvents.length ? timelineEvents : null,
        profile_json: profileJson, // Backend flattens to explicit columns
      };
    };

    const setProfileForm = (row) => {
      // Read from explicit columns (churches_v2 schema) with fallback to profile_json for backward compatibility
      const contentBlocks = row?.profile_json?.contentBlocks || {};
      const location = row?.profile_json?.location || {};
      const supplementary = row?.profile_json?.supplementary || {};
      
      // Prefer explicit columns over profile_json
      const heroImageUrl = String(row?.hero_image_url ?? row?.source_url ?? row?.profile_json?.heroImageUrl ?? "").trim();
      const heroImageSourceUrl = String(row?.source_url ?? row?.profile_json?.heroImageSourceUrl ?? "").trim();
      const planUrl = String(row?.plan_url ?? row?.profile_json?.contentBlocks?.planUrl ?? "").trim();
      const heroDateLabel = String(row?.construction_date ?? row?.hero_date_label ?? "").trim(); // construction_date is the new field name
      
      const extraProfileJson = { ...(row?.profile_json || {}) };
      delete extraProfileJson.contentBlocks;
      delete extraProfileJson.location;
      delete extraProfileJson.supplementary;
      delete extraProfileJson.heroImageUrl;
      delete extraProfileJson.heroImageSourceUrl;

      // Helper to safely set value
      const setValue = (id, value) => setFieldValue(id, value);

      setValue("p-list-entry", row?.list_entry);
      setValue("p-title", row?.title);
      setValue("p-subtitle", row?.subtitle);
      setValue("p-summary", decodeEscapedNewlines(row?.summary));
      
      const rowStatus = String(row?.editorial_status ?? "draft").trim();
      setValue("p-editorial-status", KNOWN_EDITORIAL_STATUSES.includes(rowStatus) ? rowStatus : "");
      setValue("p-editorial-status-custom", KNOWN_EDITORIAL_STATUSES.includes(rowStatus) ? "" : rowStatus);
      setValue("p-active-status", row?.current_usage || "");
      setValue("p-editorial-notes", decodeEscapedNewlines(row?.editorial_notes));
      setValue("p-church-website", row?.church_website);
      setValue("p-hero-image-url", heroImageUrl);
      setValue("p-hero-image-source-url", heroImageSourceUrl);
      setValue("p-plan-url", planUrl);
      setValue("p-hero-date-label", heroDateLabel);
      
      updateHeroPreview(heroImageUrl, heroImageSourceUrl);
      updatePlanPreview(planUrl);
      const thisListEntry = Number(row?.list_entry);
      if (moderationWorkspace) {
        moderationWorkspace.setListEntry(Number.isInteger(thisListEntry) && thisListEntry > 0 ? thisListEntry : "");
      }
      if ((!heroImageUrl || !heroImageUrl.trim()) && Number.isInteger(thisListEntry) && thisListEntry > 0) {
        fetchJson(`/api/content/church-profiles/${thisListEntry}/current-image?mode=web`)
          .then((data) => {
            if (selectedProfile?.list_entry !== thisListEntry) return;
            if (data?.imageUrl) {
              updateHeroPreview(
                data.imageUrl,
                data.sourceUrl || "",
                String(data.source || "resolved").toUpperCase()
              );
            }
          })
          .catch(() => {});
      }
      const rowTags = Array.isArray(row?.tags) ? row.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
      setMultiSelectValues("p-tags-select", rowTags.filter((tag) => KNOWN_THEME_TAGS.includes(tag)));
      setValue("p-tags-custom", rowTags.filter((tag) => !KNOWN_THEME_TAGS.includes(tag)).join(", "));
      
      // Prefer explicit columns over profile_json for content blocks
      // Note: Overview field removed from UI (no overview_detail column exists in database)
      setValue("p-history", decodeEscapedNewlines(row?.history_detail ?? contentBlocks?.history));
      setValue(
        "p-architecture",
        decodeEscapedNewlines(row?.architecture_detail ?? contentBlocks?.architecture)
      );
      setValue("p-timeline-events", timelineRowsToText(row?.timeline_events));
      
      // Prefer explicit columns over profile_json for location
      setValue("p-location-county", row?.county ?? location?.county);
      setValue("p-location-district", row?.district ?? location?.district);
      setValue("p-location-parish", row?.parish ?? location?.parish);
      
      // Prefer explicit columns over profile_json for supplementary info
      // Note: source_history, source_details, reasons_for_designation don't exist in schema
      setValue(
        "p-supp-source-summary",
        decodeEscapedNewlines(row?.additional_info ?? supplementary?.sourceSummary)
      );
      setValue("p-supp-source-history", decodeEscapedNewlines(supplementary?.sourceHistory));
      setValue("p-supp-source-details", decodeEscapedNewlines(supplementary?.sourceDetails));
      setValue("p-supp-reasons", arrayToLines(supplementary?.reasonsForDesignation));
      setValue("p-supp-listed-date", row?.date_first_listed ?? supplementary?.listedDate);
      
      const rowGrade = String(row?.grade ?? supplementary?.grade ?? "").trim();
      setValue("p-supp-grade", KNOWN_GRADES.includes(rowGrade) ? rowGrade : "");
      setValue("p-supp-grade-custom", KNOWN_GRADES.includes(rowGrade) ? "" : rowGrade);
      setValue("p-profile-json-extra", Object.keys(extraProfileJson).length ? JSON.stringify(extraProfileJson, null, 2) : "");
    };

    const renderProfiles = () => {
      profileListEl.innerHTML = "";
      if (!profileRows.length) {
        profileListEl.innerHTML = "<div class='list-item mini'>No profiles found.</div>";
        return;
      }
      profileRows.forEach((row) => {
        const item = document.createElement("div");
        item.className = `list-item ${selectedProfile && selectedProfile.list_entry === row.list_entry ? "active" : ""}`;
        
        // Prefer explicit columns over profile_json for location
        const locationLabel = [
          String(row?.parish || "").trim(),
          String(row?.district || "").trim(),
          String(row?.county || "").trim(),
          String(row?.subtitle || "").trim(),
        ].find((value) => value.length > 0);
        
        const locationBadge = locationLabel
          ? `<span class='list-badge list-badge-location'>${htmlEscape(locationLabel)}</span>`
          : "";
        const moderationBadge = row?.has_outstanding_moderation
          ? "<span class='list-badge list-badge-warning'>Moderation outstanding</span>"
          : "";
        const tagBadges = (Array.isArray(row?.tags) ? row.tags : [])
          .map((tag) => String(tag || "").trim())
          .filter(Boolean)
          .map((tag) => `<span class='list-badge list-badge-tag'>${htmlEscape(tag)}</span>`)
          .join("");
        const contextBadges = `${locationBadge}${moderationBadge}`;
        item.innerHTML = `
          <div class="list-item-title-row">
            <h4 class="list-item-title">${htmlEscape(row.title || `List Entry ${row.list_entry}`)}</h4>
          </div>
          <div class="list-item-badges">
            ${contextBadges || "<span class='mini'>No location/moderation flags</span>"}
          </div>
          <div class="list-item-badges list-item-tags">
            ${tagBadges}
          </div>
        `;
        item.onclick = async () => {
          await selectProfileByListEntry(row.list_entry);
        };
        profileListEl.appendChild(item);
      });
    };

    const selectProfileByListEntry = async (listEntry, options = {}) => {
      const numericListEntry = Number(listEntry);
      if (!Number.isInteger(numericListEntry) || numericListEntry <= 0) return;
      const shouldUpdateUrl = options.syncUrl !== false;
      try {
        const data = await fetchJson(`/api/content/church-profiles/${numericListEntry}`);
        selectedProfile = data.row;
        setProfileForm(selectedProfile);
        renderProfiles();
        if (moderationWorkspace) {
          await moderationWorkspace.loadQueue();
        }
        if (shouldUpdateUrl) {
          updateUrlParams({ listingId: numericListEntry });
        }
      } catch (error) {
        setMessage(messageEl, error.message, "error");
      }
    };

    const loadProfiles = async () => {
      const query = document.getElementById("profile-query").value.trim();
      const status = document.getElementById("profile-status-filter")?.value?.trim() || "";
      const moderation = document.getElementById("profile-moderation-filter")?.value?.trim() || "";
      const county = document.getElementById("profile-county-filter")?.value?.trim() || "";
      const town = document.getElementById("profile-town-filter")?.value?.trim() || "";
      setMessage(statusEl, "Loading profiles...");
      try {
        const qs = new URLSearchParams({ limit: "50" });
        qs.set("with_moderation", "1");
        if (query) qs.set("query", query);
        if (status) qs.set("status", status);
        if (moderation) qs.set("moderation", moderation);
        if (county) qs.set("county", county);
        if (town) qs.set("town", town);
        const data = await fetchJson(`/api/content/church-profiles?${qs.toString()}`);
        profileRows = data.rows || [];
        const activeFilters = [
          status ? `status=${status}` : "",
          moderation ? `moderation=${moderation}` : "",
          county ? `county=${county}` : "",
          town ? `town=${town}` : "",
        ].filter(Boolean);
        const filterSuffix = activeFilters.length ? ` (${activeFilters.join(", ")})` : "";
        const total = typeof data.total === "number" ? data.total : profileRows.length;
        setMessage(statusEl, `${profileRows.length}/${total} profiles loaded${filterSuffix}`, "success");
        renderProfiles();
      } catch (error) {
        setMessage(statusEl, error.message, "error");
      }
    };

    const saveProfile = async () => {
      setMessage(messageEl, "Saving...");
      try {
        const payload = profileFormValues();
        const listEntry = Number(payload.list_entry);
        if (!Number.isInteger(listEntry) || listEntry <= 0) throw new Error("List Entry must be a positive number.");
        const existing = selectedProfile && selectedProfile.list_entry === listEntry;
        const endpoint = existing ? `/api/content/church-profiles/${listEntry}` : "/api/content/church-profiles";
        const method = existing ? "PATCH" : "POST";
        const data = await fetchJson(endpoint, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        selectedProfile = data.row;
        setProfileForm(selectedProfile);
        await loadProfiles();
        updateUrlParams({ listingId: selectedProfile?.list_entry ?? listEntry });
        setMessage(messageEl, "Profile saved.", "success");
      } catch (error) {
        setMessage(messageEl, error.message, "error");
      }
    };

    const uploadHeroImage = async () => {
      setMessage(messageEl, "Uploading image...");
      try {
        const listEntry = Number(document.getElementById("p-list-entry").value);
        if (!Number.isInteger(listEntry) || listEntry <= 0) {
          throw new Error("Set a valid List Entry before uploading.");
        }
        const file = heroFileEl?.files?.[0];
        if (!file) throw new Error("Choose an image file first.");
        const base64Data = await fileToBase64(file);
        const sourceUrl = document.getElementById("p-hero-image-source-url").value.trim();
        const data = await fetchJson(`/api/content/church-profiles/${listEntry}/upload-image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: file.name,
            mimeType: file.type || "image/jpeg",
            base64Data,
            sourceUrl: sourceUrl || null,
          }),
        });
        selectedProfile = data.row ?? selectedProfile;
        if (data.publicUrl) {
          document.getElementById("p-hero-image-url").value = data.publicUrl;
        }
        setProfileForm(selectedProfile);
        await loadProfiles();
        if (heroFileEl) heroFileEl.value = "";
        setMessage(messageEl, "Image uploaded and set as hero image.", "success");
      } catch (error) {
        setMessage(messageEl, error.message, "error");
      }
    };

    const uploadPlanImage = async () => {
      setMessage(messageEl, "Uploading plan image...");
      try {
        const listEntry = Number(document.getElementById("p-list-entry").value);
        if (!Number.isInteger(listEntry) || listEntry <= 0) {
          throw new Error("Set a valid List Entry before uploading.");
        }
        const file = planFileEl?.files?.[0];
        if (!file) throw new Error("Choose a plan image file first.");
        const base64Data = await fileToBase64(file);
        const data = await fetchJson(`/api/content/church-profiles/${listEntry}/upload-plan-image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: file.name,
            mimeType: file.type || "image/jpeg",
            base64Data,
          }),
        });
        selectedProfile = data.row ?? selectedProfile;
        if (data.publicUrl) {
          document.getElementById("p-plan-url").value = data.publicUrl;
        }
        setProfileForm(selectedProfile);
        await loadProfiles();
        if (planFileEl) planFileEl.value = "";
        setMessage(messageEl, "Plan image uploaded and linked.", "success");
      } catch (error) {
        setMessage(messageEl, error.message, "error");
      }
    };

    const createFolklore = async () => {
      const folkloreStatusEl = document.getElementById("p-folklore-status");
      setMessage(folkloreStatusEl, "Creating folklore story...");
      try {
        const listEntry = Number(document.getElementById("p-list-entry").value);
        if (!Number.isInteger(listEntry) || listEntry <= 0) {
          throw new Error("Select a valid church profile first.");
        }
        const folkloreTitle = document.getElementById("p-folklore-title").value.trim();
        const folkloreText = document.getElementById("p-folklore-text").value.trim();
        
        if (!folkloreText) {
          throw new Error("Folklore story text is required.");
        }
        
        if (folkloreText.length < 20) {
          throw new Error("Folklore story must be at least 20 characters.");
        }

        await fetchJson(`/api/content/church-profiles/${listEntry}/create-folklore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folklore_title: folkloreTitle || null,
            folklore_text: convertNewlinesToBr(folkloreText),
          }),
        });

        // Clear the form
        document.getElementById("p-folklore-title").value = "";
        document.getElementById("p-folklore-text").value = "";
        
        setMessage(folkloreStatusEl, "Folklore story created and approved!", "success");
        
        // Reload moderation to show the new story
        if (moderationWorkspace) {
          await moderationWorkspace.loadQueue();
        }
      } catch (error) {
        setMessage(folkloreStatusEl, error.message, "error");
      }
    };

    const deleteProfile = async () => {
      const listEntry = Number(document.getElementById("p-list-entry").value);
      if (!Number.isInteger(listEntry) || listEntry <= 0) {
        setMessage(messageEl, "Select a valid profile first.", "error");
        return;
      }
      if (!confirm(`Delete profile ${listEntry}? This cannot be undone.`)) return;
      try {
        await fetchJson(`/api/content/church-profiles/${listEntry}`, { method: "DELETE" });
        selectedProfile = null;
        setProfileForm(null);
        await loadProfiles();
        updateUrlParams({ listingId: null });
        if (moderationWorkspace) {
          await moderationWorkspace.loadQueue();
        }
        setMessage(messageEl, "Profile deleted.", "success");
      } catch (error) {
        setMessage(messageEl, error.message, "error");
      }
    };

    try {
      const status = await fetchJson("/api/content/status");
      if (!status.ready) {
        setMessage(statusEl, "Supabase admin config missing in .env.local", "error");
        return;
      }
      await loadProfiles();
      if (requestedListingId && requestedListingId > 0) {
        await selectProfileByListEntry(requestedListingId, { syncUrl: false });
      }
    } catch (error) {
      setMessage(statusEl, error.message, "error");
    }

    document.getElementById("profile-search-btn").onclick = loadProfiles;
    document.getElementById("profile-clear-filters-btn").onclick = () => {
      document.getElementById("profile-query").value = "";
      document.getElementById("profile-status-filter").value = "";
      document.getElementById("profile-moderation-filter").value = "";
      document.getElementById("profile-county-filter").value = "";
      document.getElementById("profile-town-filter").value = "";
      loadProfiles();
    };
    document.getElementById("profile-new-btn").onclick = () => {
      selectedProfile = null;
      setProfileForm(null);
      setMessage(messageEl, "Creating a new profile.");
      updateUrlParams({ listingId: null });
      if (moderationWorkspace) {
        moderationWorkspace.loadQueue().catch(() => {});
      }
    };
    document.getElementById("profile-save-btn").onclick = saveProfile;
    document.getElementById("profile-delete-btn").onclick = deleteProfile;
    document.getElementById("p-hero-image-upload-btn").onclick = uploadHeroImage;
    document.getElementById("p-plan-image-upload-btn").onclick = uploadPlanImage;
    document.getElementById("p-folklore-create-btn").onclick = createFolklore;
    document.getElementById("p-hero-image-url").addEventListener("input", () => {
      updateHeroPreview(
        document.getElementById("p-hero-image-url").value,
        document.getElementById("p-hero-image-source-url").value
      );
    });
    document.getElementById("p-hero-image-source-url").addEventListener("input", () => {
      updateHeroPreview(
        document.getElementById("p-hero-image-url").value,
        document.getElementById("p-hero-image-source-url").value
      );
    });
    document.getElementById("p-plan-url").addEventListener("input", () => {
      updatePlanPreview(document.getElementById("p-plan-url").value);
    });
    if (moderationWorkspace) {
      moderationWorkspace.loadQueue().catch(() => {});
    }
  }

  async function initHistoryFactsPage() {
    const factListEl = document.getElementById("fact-list");
    if (!factListEl) return;

    let selectedFact = null;
    let factRows = [];
    const statusEl = document.getElementById("fact-status");
    const messageEl = document.getElementById("fact-message");
    const filterDateEl = document.getElementById("fact-filter-date");

    const getFilterMonthDay = () => {
      const raw = String(filterDateEl?.value || "").trim();
      if (!raw) return null;
      const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return null;
      return {
        month: Number(match[2]),
        day: Number(match[3]),
        label: raw,
      };
    };

    const factFormValues = () => ({
      id: document.getElementById("f-id").value.trim(),
      month: document.getElementById("f-month").value.trim(),
      day: document.getElementById("f-day").value.trim(),
      year: document.getElementById("f-year").value.trim(),
      short_description: document.getElementById("f-short-description").value.trim(),
      long_description: document.getElementById("f-long-description").value.trim(),
    });

    const setFactForm = (row) => {
      document.getElementById("f-id").value = row?.id ?? "";
      document.getElementById("f-month").value = row?.month ?? "";
      document.getElementById("f-day").value = row?.day ?? "";
      document.getElementById("f-year").value = row?.year ?? "";
      document.getElementById("f-short-description").value = row?.short_description ?? "";
      document.getElementById("f-long-description").value = row?.long_description ?? "";
    };

    const renderFacts = () => {
      factListEl.innerHTML = "";
      if (!factRows.length) {
        factListEl.innerHTML = "<div class='list-item mini'>No facts found.</div>";
        return;
      }
      factRows.forEach((row) => {
        const item = document.createElement("div");
        item.className = `list-item ${selectedFact && selectedFact.id === row.id ? "active" : ""}`;
        item.innerHTML = `
          <h4>${htmlEscape(row.short_description || "Untitled fact")}</h4>
          <div class="mini">${row.day}/${row.month}${row.year ? `/${row.year}` : ""} | id ${row.id}</div>
        `;
        item.onclick = async () => {
          try {
            const data = await fetchJson(`/api/content/history-facts/${row.id}`);
            selectedFact = data.row;
            setFactForm(selectedFact);
            renderFacts();
          } catch (error) {
            setMessage(messageEl, error.message, "error");
          }
        };
        factListEl.appendChild(item);
      });
    };

    const loadFacts = async () => {
      setMessage(statusEl, "Loading facts...");
      try {
        const filter = getFilterMonthDay();
        const filterQuery = filter ? `&month=${filter.month}&day=${filter.day}` : "";
        const data = await fetchJson(`/api/content/history-facts?limit=200${filterQuery}`);
        factRows = data.rows || [];
        if (filter) {
          setMessage(statusEl, `${factRows.length} facts for ${filter.label}`, "success");
        } else {
          setMessage(statusEl, `${factRows.length} facts loaded`, "success");
        }
        renderFacts();
      } catch (error) {
        setMessage(statusEl, error.message, "error");
      }
    };

    const saveFact = async () => {
      setMessage(messageEl, "Saving...");
      try {
        const payload = factFormValues();
        const factId = Number(payload.id);
        const existing = Number.isInteger(factId) && factId > 0;
        const endpoint = existing ? `/api/content/history-facts/${factId}` : "/api/content/history-facts";
        const method = existing ? "PATCH" : "POST";
        const data = await fetchJson(endpoint, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        selectedFact = data.row;
        setFactForm(selectedFact);
        await loadFacts();
        setMessage(messageEl, "Fact saved.", "success");
      } catch (error) {
        setMessage(messageEl, error.message, "error");
      }
    };

    const deleteFact = async () => {
      const factId = Number(document.getElementById("f-id").value);
      if (!Number.isInteger(factId) || factId <= 0) {
        setMessage(messageEl, "Select a saved fact first.", "error");
        return;
      }
      if (!confirm(`Delete fact ${factId}? This cannot be undone.`)) return;
      try {
        await fetchJson(`/api/content/history-facts/${factId}`, { method: "DELETE" });
        selectedFact = null;
        setFactForm(null);
        await loadFacts();
        setMessage(messageEl, "Fact deleted.", "success");
      } catch (error) {
        setMessage(messageEl, error.message, "error");
      }
    };

    try {
      const status = await fetchJson("/api/content/status");
      if (!status.ready) {
        setMessage(statusEl, "Supabase admin config missing in .env.local", "error");
        return;
      }
      await loadFacts();
    } catch (error) {
      setMessage(statusEl, error.message, "error");
    }

    document.getElementById("fact-refresh-btn").onclick = loadFacts;
    document.getElementById("fact-new-btn").onclick = () => {
      selectedFact = null;
      setFactForm(null);
      setMessage(messageEl, "Creating a new fact.");
    };
    document.getElementById("fact-save-btn").onclick = saveFact;
    document.getElementById("fact-delete-btn").onclick = deleteFact;
    const filterBtn = document.getElementById("fact-filter-btn");
    const clearFilterBtn = document.getElementById("fact-clear-filter-btn");
    if (filterBtn) {
      filterBtn.onclick = () => {
        loadFacts().catch(() => {});
      };
    }
    if (clearFilterBtn) {
      clearFilterBtn.onclick = () => {
        if (filterDateEl) filterDateEl.value = "";
        loadFacts().catch(() => {});
      };
    }
    if (filterDateEl) {
      filterDateEl.addEventListener("change", () => {
        loadFacts().catch(() => {});
      });
    }
  }

  async function initChurchOfDayPage() {
    const codListEl = document.getElementById("cod-list");
    if (!codListEl) return;
    setupRichTextEditors(["cod-rich-summary"]);

    let selectedEntry = null;
    let codRows = [];
    const statusEl = document.getElementById("cod-status");
    const messageEl = document.getElementById("cod-message");
    const filterDateEl = document.getElementById("cod-filter-date");

    const codFormValues = () => ({
      feature_date: getFieldValue("cod-feature-date"),
      list_entry: getFieldValue("cod-list-entry"),
      rich_summary: convertNewlinesToBr(getFieldValue("cod-rich-summary")),
    });

    const setCodForm = (row) => {
      setFieldValue("cod-feature-date", row?.feature_date ?? "");
      setFieldValue("cod-list-entry", row?.list_entry ?? "");
      setFieldValue("cod-rich-summary", row?.rich_summary ?? "");
    };

    const renderEntries = () => {
      codListEl.innerHTML = "";
      if (!codRows.length) {
        codListEl.innerHTML = "<div class='list-item mini'>No church-of-day entries found.</div>";
        return;
      }
      codRows.forEach((row) => {
        const item = document.createElement("div");
        item.className =
          `list-item ${selectedEntry && selectedEntry.feature_date === row.feature_date ? "active" : ""}`;
        const profile =
          (row?.churches_v2 && typeof row.churches_v2 === "object" ? row.churches_v2 : null) ||
          (row?.church_profiles && typeof row.church_profiles === "object" ? row.church_profiles : null);
        const profileTitle = String(profile?.title || "").trim();
        const profileSubtitle = String(profile?.subtitle || "").trim();
        const title = profileTitle || `Listing ${row.list_entry}`;
        const subtitle = profileSubtitle ? ` | ${profileSubtitle}` : "";
        item.innerHTML = `
          <h4>${htmlEscape(title)}</h4>
          <div class="mini">${htmlEscape(row.feature_date)} | list ${htmlEscape(row.list_entry)}${htmlEscape(subtitle)}</div>
        `;
        item.onclick = async () => {
          try {
            const data = await fetchJson(`/api/content/church-of-day/${row.feature_date}`);
            selectedEntry = data.row;
            setCodForm(selectedEntry);
            renderEntries();
          } catch (error) {
            setMessage(messageEl, error.message, "error");
          }
        };
        codListEl.appendChild(item);
      });
    };

    const loadEntries = async () => {
      setMessage(statusEl, "Loading entries...");
      try {
        const qs = new URLSearchParams({ limit: "200" });
        const featureDate = String(filterDateEl?.value || "").trim();
        if (featureDate) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(featureDate)) {
            throw new Error("Filter date must be YYYY-MM-DD.");
          }
          qs.set("feature_date", featureDate);
        }
        const data = await fetchJson(`/api/content/church-of-day?${qs.toString()}`);
        codRows = data.rows || [];
        const suffix = featureDate ? ` for ${featureDate}` : "";
        setMessage(statusEl, `${codRows.length} entries loaded${suffix}`, "success");
        renderEntries();
      } catch (error) {
        setMessage(statusEl, error.message, "error");
      }
    };

    const saveEntry = async () => {
      setMessage(messageEl, "Saving...");
      try {
        const payload = compactObject(codFormValues());
        if (!payload.feature_date) {
          throw new Error("Feature date is required.");
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.feature_date)) {
          throw new Error("Feature date must be YYYY-MM-DD.");
        }
        const listEntry = Number(payload.list_entry);
        if (!Number.isInteger(listEntry) || listEntry <= 0) {
          throw new Error("List entry must be a positive integer.");
        }
        payload.list_entry = listEntry;

        const data = await fetchJson("/api/content/church-of-day", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        selectedEntry = data.row;
        setCodForm(selectedEntry);
        await loadEntries();
        setMessage(messageEl, "Church of the day entry saved.", "success");
      } catch (error) {
        setMessage(messageEl, error.message, "error");
      }
    };

    const deleteEntry = async () => {
      const featureDate = document.getElementById("cod-feature-date").value.trim();
      if (!featureDate) {
        setMessage(messageEl, "Enter or select a feature date first.", "error");
        return;
      }
      if (!confirm(`Delete church-of-day entry for ${featureDate}? This cannot be undone.`)) return;
      try {
        await fetchJson(`/api/content/church-of-day/${featureDate}`, { method: "DELETE" });
        selectedEntry = null;
        setCodForm(null);
        await loadEntries();
        setMessage(messageEl, "Entry deleted.", "success");
      } catch (error) {
        setMessage(messageEl, error.message, "error");
      }
    };

    try {
      const status = await fetchJson("/api/content/status");
      if (!status.ready) {
        setMessage(statusEl, "Supabase admin config missing in .env.local", "error");
        return;
      }
      await loadEntries();
    } catch (error) {
      setMessage(statusEl, error.message, "error");
    }

    document.getElementById("cod-refresh-btn").onclick = loadEntries;
    const filterBtn = document.getElementById("cod-filter-btn");
    const clearFilterBtn = document.getElementById("cod-clear-filter-btn");
    if (filterBtn) {
      filterBtn.onclick = () => {
        loadEntries().catch(() => {});
      };
    }
    if (clearFilterBtn) {
      clearFilterBtn.onclick = () => {
        if (filterDateEl) filterDateEl.value = "";
        loadEntries().catch(() => {});
      };
    }
    if (filterDateEl) {
      filterDateEl.addEventListener("change", () => {
        loadEntries().catch(() => {});
      });
    }
    document.getElementById("cod-new-btn").onclick = () => {
      selectedEntry = null;
      setCodForm(null);
      setMessage(messageEl, "Creating a new church-of-day entry.");
    };
    document.getElementById("cod-save-btn").onclick = saveEntry;
    document.getElementById("cod-delete-btn").onclick = deleteEntry;
  }

  async function initModerationPage() {
    const listEl = document.getElementById("moderation-list");
    if (!listEl) return;

    const statusEl = document.getElementById("moderation-status");
    const refreshBtnEl = document.getElementById("moderation-refresh-btn");
    const listingSubmissionsListEl = document.getElementById("listing-submissions-list");
    const listingSubmissionsStatusEl = document.getElementById("listing-submissions-status");
    const listingSubmissionsRefreshBtnEl = document.getElementById("listing-submissions-refresh-btn");
    const listingSubmissionsStatusFilterEl = document.getElementById("listing-submissions-status-filter");

    const fmtCount = (value, label) => `${value} ${label}`;

    const renderRows = (rows) => {
      listEl.innerHTML = "";
      if (!rows.length) {
        listEl.innerHTML = "<div class='list-item mini'>No outstanding moderation tasks.</div>";
        return;
      }
      rows.forEach((row) => {
        const subtitle = String(row?.subtitle || "").trim();
        const card = document.createElement("article");
        card.className = "moderation-item";
        card.innerHTML = `
          <h3 class="moderation-title">${htmlEscape(row.title || `List ${row.list_entry}`)}</h3>
          <p class="moderation-meta">List ${htmlEscape(row.list_entry)}${subtitle ? ` | ${htmlEscape(subtitle)}` : ""}</p>
          <div class="moderation-body">
            ${htmlEscape(
              [
                fmtCount(Number(row?.counts?.text || 0), "text"),
                fmtCount(Number(row?.counts?.folklore || 0), "folklore"),
                fmtCount(Number(row?.counts?.image || 0), "images"),
                fmtCount(Number(row?.counts?.audio || 0), "audio"),
                fmtCount(Number(row?.counts?.memory || 0), "memories"),
                fmtCount(Number(row?.counts?.people || 0), "people"),
              ].join(" | ")
            )}
          </div>
          <div class="moderation-body"><strong>Total outstanding:</strong> ${htmlEscape(row.total || 0)}</div>
          <div class="moderation-actions">
            <button data-action="open-listing" data-list-entry="${row.list_entry}">Open Listing Moderation</button>
          </div>
        `;
        listEl.appendChild(card);
      });
    };

    const loadRows = async () => {
      setMessage(statusEl, "Loading outstanding moderation tasks...");
      try {
        const data = await fetchJson("/api/moderation/outstanding");
        const rows = Array.isArray(data?.rows) ? data.rows : [];
        renderRows(rows);
        setMessage(statusEl, `${rows.length} listings with outstanding tasks`, "success");
      } catch (error) {
        setMessage(statusEl, error.message, "error");
      }
    };

    const toSubmissionTitle = (row) =>
      String(row?.title || row?.church_name || row?.name || `Submission #${row?.id || "?"}`).trim();

    const toSubmissionSubtitle = (row) =>
      String(row?.subtitle || row?.parish || row?.district || row?.county || row?.town || "").trim();

    const toSubmissionImageUrl = (row) =>
      String(row?.hero_image_url || row?.image_url || "").trim();

    const renderListingSubmissions = (rows) => {
      if (!listingSubmissionsListEl) return;
      listingSubmissionsListEl.innerHTML = "";
      if (!rows.length) {
        listingSubmissionsListEl.innerHTML = "<div class='list-item mini'>No submissions found for this status.</div>";
        return;
      }
      rows.forEach((row) => {
        const title = toSubmissionTitle(row);
        const subtitle = toSubmissionSubtitle(row);
        const imageUrl = toSubmissionImageUrl(row);
        const locationDescription = String(row?.location_description || "").trim();
        const parish = String(row?.parish || "").trim();
        const district = String(row?.district || "").trim();
        const county = String(row?.county || "").trim();
        const postcode = String(row?.postcode || "").trim();
        const denomination = String(row?.denomination || "").trim();
        const grade = String(row?.grade || "").trim();
        const constructionDate = String(row?.construction_date || "").trim();
        const websiteUrl = String(row?.website_url || "").trim();
        const heritageUrl = String(row?.heritage_listing_url || "").trim();
        const reason = String(row?.reason_for_submission || "").trim();
        const storagePath = String(row?.hero_image_storage_path || "").trim();
        const latitude = row?.latitude;
        const longitude = row?.longitude;
        const createdListEntry = Number(row?.created_list_entry);
        const canOpenCreatedListing = Number.isInteger(createdListEntry) && createdListEntry > 0;
        const card = document.createElement("article");
        card.className = "moderation-item";
        card.innerHTML = `
          <h3 class="moderation-title">#${row.id} | ${htmlEscape(title)}</h3>
          <p class="moderation-meta">Status: ${htmlEscape(row.status || "unknown")} | User: ${htmlEscape(row.user_id || "unknown")} | ${htmlEscape(row.created_at || "")}</p>
          ${locationDescription ? `<div class="moderation-body"><strong>Location description:</strong> ${htmlEscape(locationDescription)}</div>` : ""}
          ${subtitle ? `<div class="moderation-body"><strong>Location:</strong> ${htmlEscape(subtitle)}</div>` : ""}
          ${(parish || district || county) ? `<div class="moderation-body"><strong>Parish/District/County:</strong> ${htmlEscape([parish, district, county].filter(Boolean).join(" / "))}</div>` : ""}
          ${postcode ? `<div class="moderation-body"><strong>Postcode:</strong> ${htmlEscape(postcode)}</div>` : ""}
          ${(latitude !== null && latitude !== undefined) || (longitude !== null && longitude !== undefined) ? `<div class="moderation-body"><strong>Coordinates:</strong> ${htmlEscape(`${latitude ?? "?"}, ${longitude ?? "?"}`)}</div>` : ""}
          ${denomination ? `<div class="moderation-body"><strong>Denomination:</strong> ${htmlEscape(denomination)}</div>` : ""}
          ${grade ? `<div class="moderation-body"><strong>Grade:</strong> ${htmlEscape(grade)}</div>` : ""}
          ${constructionDate ? `<div class="moderation-body"><strong>Construction date:</strong> ${htmlEscape(constructionDate)}</div>` : ""}
          ${row?.description ? `<div class="moderation-body"><strong>Description:</strong><br/>${htmlEscape(String(row.description)).replace(/\n/g, "<br/>")}</div>` : ""}
          ${reason ? `<div class="moderation-body"><strong>Reason for submission:</strong><br/>${htmlEscape(reason).replace(/\n/g, "<br/>")}</div>` : ""}
          ${websiteUrl ? `<div class="moderation-body"><a href="${htmlEscape(websiteUrl)}" target="_blank" rel="noreferrer">Open website URL</a></div>` : ""}
          ${heritageUrl ? `<div class="moderation-body"><a href="${htmlEscape(heritageUrl)}" target="_blank" rel="noreferrer">Open heritage listing URL</a></div>` : ""}
          ${imageUrl ? `<img class="moderation-media" src="${htmlEscape(imageUrl)}" alt="Listing submission image" />` : ""}
          ${imageUrl ? `<div class="moderation-body"><a href="${htmlEscape(imageUrl)}" target="_blank" rel="noreferrer">Open image</a></div>` : ""}
          ${storagePath ? `<div class="moderation-body"><strong>Image storage path:</strong> ${htmlEscape(storagePath)}</div>` : ""}
          <div class="moderation-body"><strong>created_list_entry:</strong> ${canOpenCreatedListing ? createdListEntry : "not set"}</div>
          <div class="moderation-actions">
            <textarea data-submission-notes="${row.id}" class="span-2" placeholder="Admin notes">${htmlEscape(row.admin_notes || "")}</textarea>
            <button data-action="approve-submission" data-id="${row.id}">Approve + Create/Update Listing</button>
            <button data-action="reject-submission" data-id="${row.id}" class="danger">Reject</button>
            <button data-action="duplicate-submission" data-id="${row.id}" class="ghost">Mark Duplicate</button>
            <button data-action="pending-submission" data-id="${row.id}" class="ghost">Mark Pending</button>
            ${canOpenCreatedListing ? `<button data-action="open-created-listing" data-list-entry="${createdListEntry}" class="ghost">Open Created Listing</button>` : ""}
          </div>
        `;
        listingSubmissionsListEl.appendChild(card);
      });
    };

    const loadListingSubmissions = async () => {
      if (!listingSubmissionsListEl) return;
      const status = String(listingSubmissionsStatusFilterEl?.value || "pending").trim();
      setMessage(listingSubmissionsStatusEl, "Loading listing submissions...");
      try {
        const data = await fetchJson(`/api/moderation/listing-submissions?status=${encodeURIComponent(status)}`);
        const rows = Array.isArray(data?.rows) ? data.rows : [];
        renderListingSubmissions(rows);
        setMessage(listingSubmissionsStatusEl, `${rows.length} submissions (${status})`, "success");
      } catch (error) {
        setMessage(listingSubmissionsStatusEl, error.message, "error");
      }
    };

    listEl.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action='open-listing']");
      if (!button) return;
      const listEntry = Number(button.getAttribute("data-list-entry"));
      if (!Number.isInteger(listEntry) || listEntry <= 0) return;
      window.location.href = `/church-profiles?section=moderation&listingId=${listEntry}`;
    });

    listingSubmissionsListEl?.addEventListener("click", async (event) => {
      const openBtn = event.target.closest("button[data-action='open-created-listing']");
      if (openBtn) {
        const listEntry = Number(openBtn.getAttribute("data-list-entry"));
        if (Number.isInteger(listEntry) && listEntry > 0) {
          window.location.href = `/church-profiles?section=moderation&listingId=${listEntry}`;
        }
        return;
      }

      const actionBtn = event.target.closest("button[data-action$='-submission']");
      if (!actionBtn) return;
      const id = Number(actionBtn.getAttribute("data-id"));
      if (!Number.isInteger(id) || id <= 0) return;
      const action = String(actionBtn.getAttribute("data-action") || "");
      const status =
        action === "approve-submission"
          ? "approved"
          : action === "reject-submission"
            ? "rejected"
            : action === "duplicate-submission"
              ? "duplicate"
            : "pending";
      const notesEl = actionBtn.parentElement?.querySelector(`textarea[data-submission-notes="${id}"]`);
      const adminNotes = notesEl ? notesEl.value.trim() : "";
      try {
        actionBtn.disabled = true;
        await fetchJson(`/api/moderation/listing-submissions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status, admin_notes: adminNotes || null }),
        });
        await Promise.all([loadListingSubmissions(), loadRows()]);
      } catch (error) {
        setMessage(listingSubmissionsStatusEl, error.message, "error");
      } finally {
        actionBtn.disabled = false;
      }
    });

    if (refreshBtnEl) {
      refreshBtnEl.onclick = () => {
        loadRows().catch(() => {});
      };
    }
    if (listingSubmissionsRefreshBtnEl) {
      listingSubmissionsRefreshBtnEl.onclick = () => {
        loadListingSubmissions().catch(() => {});
      };
    }
    listingSubmissionsStatusFilterEl?.addEventListener("change", () => {
      loadListingSubmissions().catch(() => {});
    });

    await Promise.all([loadRows(), loadListingSubmissions()]);
  }

  // Hide page content until auth is verified
  const main = document.querySelector("main");
  if (main) main.style.display = "none";

  fetchJson("/api/auth/me")
    .then(() => {
      if (main) main.style.display = "";
      ensureAuthHeaderActions();
      initProfilesPage().catch(() => {});
      initHistoryFactsPage().catch(() => {});
      initChurchOfDayPage().catch(() => {});
      initModerationPage().catch(() => {});
    })
    .catch(() => {});
})();
