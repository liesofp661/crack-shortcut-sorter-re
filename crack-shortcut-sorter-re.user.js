// ==UserScript==
// @name         🔀 Crack Shortcut Sorter RE
// @namespace    crack-shortcut-sorter.local
// @version      2.1.1
// @description  로컬 라이브러리·채팅별 프리셋·전체/내 단축어 반영. 백업·동의·실제 서버 ID 검증을 거치는 수동 네이티브 적용.
// @author       WriboongE
// @match        https://crack.wrtn.ai/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const GUARD = '__CRACK_SHORTCUT_SORTER_7f3a_v1__';
  const STORAGE_KEY = '__crack_shortcut_sorter_v1__';
  const CONTROL = 'data-crack-shortcut-sorter-control';
  const API_ORIGIN = 'https://crack-api.wrtn.ai';
  const ME_PATH = '/crack-gen/shortcut-commands/me';
  const CHAT_PATH = /^\/crack-gen\/shortcut-commands\/chats\/[^/]+$/;
  const PREFIX = '[CrackShortcutSorter]';
  if (Object.prototype.hasOwnProperty.call(window, GUARD)) return;
  try {
    Object.defineProperty(window, GUARD, { value: true, configurable: false });
  } catch {
    return;
  }

  const warned = new Set();
  function warnOnce(code, message) {
    if (warned.has(code)) return;
    warned.add(code);
    try { console.warn(`${PREFIX} ${message}`); } catch { /* No sensitive diagnostics. */ }
  }

  const defaults = () => ({ schemaVersion: 1, enabled: false, masterOrder: [] });
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isID = value => typeof value === 'string' && value.length > 0 && value.trim() === value;

  function validateSettings(value) {
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') return null;
    const order = value.masterOrder === undefined && !value.enabled ? [] : value.masterOrder;
    if (!Array.isArray(order) || !order.every(isID) || new Set(order).size !== order.length) return null;
    return { schemaVersion: 1, enabled: value.enabled, masterOrder: order.slice() };
  }

  function loadSettings() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === null) return defaults();
      const value = validateSettings(JSON.parse(raw));
      if (value) return value;
    } catch { /* Corrupt or inaccessible storage must never affect Crack. */ }
    warnOnce('storage-read', 'invalid or unavailable stored settings; using default order');
    return defaults();
  }

  function buildRankMap(order) {
    return new Map(order.map((id, index) => [id, index]));
  }

  let settings = defaults(); // Account-scoped settings are loaded after verified identity.
  let ranks = buildRankMap(settings.masterOrder);
  let orderVersion = 0;
  let hookActive = false;
  let latestMeSnapshot = null;
  let latestMeSequence = -1;
  let requestSequence = 0;
  let activeEditor = null;

  function applySettings(next) {
    settings = next;
    ranks = buildRankMap(next.masterOrder);
    orderVersion += 1;
  }

  async function saveSettings(next) {
    const checked = validateSettings(next);
    if (!checked || !libraryRuntime.authorised()) return false;
    try {
      const opened = await libraryRuntime.openState();
      const nextState = opened.state;
      nextState.settings.legacy = checked;
      await libraryRuntime.save(nextState, opened.state.revision);
      applySettings(checked);
      return true;
    } catch {
      warnOnce('storage-write', 'settings could not be saved; current order retained');
      return false;
    }
  }

  function sortingEnabled() {
    return hookActive && libraryRuntime.authorised() && settings.enabled && ranks.size > 0;
  }

  function validPersonalArray(items) {
    if (!Array.isArray(items)) return false;
    const ids = new Set();
    for (const item of items) {
      if (!isRecord(item) || !isID(item._id) || typeof item.isPinned !== 'boolean' || ids.has(item._id)) return false;
      ids.add(item._id);
    }
    return true;
  }

  function rankItems(items, rankMap) {
    return items.map((item, index) => ({ item, index, rank: rankMap.get(item._id) ?? Infinity }))
      .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank < b.rank ? -1 : 1))
      .map(entry => entry.item);
  }

  // Sort only selected slots with exactly the same boolean pin state.
  // Item objects are never modified, copied, or transferred between groups.
  function reorderSamePinSlots(items, rankMap, selected = () => true) {
    const pinned = [];
    const normal = [];
    for (const item of items) {
      if (selected(item)) (item.isPinned ? pinned : normal).push(item);
    }
    const groups = [rankItems(normal, rankMap), rankItems(pinned, rankMap)];
    const cursors = [0, 0];
    let changed = false;
    const reordered = items.map(item => {
      if (!selected(item)) return item;
      const group = item.isPinned ? 1 : 0;
      const next = groups[group][cursors[group]++];
      if (next !== item) changed = true;
      return next;
    });
    return changed ? reordered : items;
  }

  function reorderTotalPersonalSlots(total, personalIds, rankMap) {
    return reorderSamePinSlots(total, rankMap, item => personalIds.has(item._id));
  }

  function transformMePayload(body, rankMap) {
    if (!isRecord(body) || !isRecord(body.data) || !validPersonalArray(body.data.items)) return body;
    const items = reorderSamePinSlots(body.data.items, rankMap);
    return items === body.data.items ? body : { ...body, data: { ...body.data, items } };
  }

  function transformChatPayload(body, rankMap) {
    if (!isRecord(body) || !isRecord(body.data) || !validPersonalArray(body.data.personal)) return body;
    const data = body.data;
    const personalIds = new Set(data.personal.map(item => item._id));
    // If total is absent, personal remains independently supported. A present
    // but malformed total makes this entire payload fail open.
    if (Object.prototype.hasOwnProperty.call(data, 'total')) {
      if (!Array.isArray(data.total)) return body;
      const seen = new Set();
      for (const item of data.total) {
        if (!isRecord(item) || !isID(item._id) || seen.has(item._id)) return body;
        seen.add(item._id);
        if (personalIds.has(item._id) && typeof item.isPinned !== 'boolean') return body;
      }
    }
    const personal = reorderSamePinSlots(data.personal, rankMap);
    const total = Array.isArray(data.total) ? reorderTotalPersonalSlots(data.total, personalIds, rankMap) : data.total;
    if (personal === data.personal && total === data.total) return body;
    const next = { ...data, personal };
    if (Array.isArray(data.total)) next.total = total;
    return { ...body, data: next };
  }

  function identifyTargetRequest(method, input) {
    // Avoid coercing arbitrary caller objects a second time: native open owns
    // their WebIDL conversion and exceptions. Crack uses string URLs.
    if (typeof method !== 'string' || method.toUpperCase() !== 'GET' || typeof input !== 'string') return null;
    try {
      const url = new URL(input, document.baseURI);
      if (url.origin !== API_ORIGIN) return null;
      if (url.pathname === ME_PATH) return 'me';
      if (CHAT_PATH.test(url.pathname)) return 'chat';
    } catch { /* Native open still decides whether the URL is acceptable. */ }
    return null;
  }

  function captureLatestMeSnapshot(body, sequence) {
    if (sequence < latestMeSequence) return;
    latestMeSequence = sequence;
    if (!isRecord(body) || !isRecord(body.data) || !validPersonalArray(body.data.items)) {
      latestMeSnapshot = null;
      return;
    }
    latestMeSnapshot = body.data.items.map(item => ({
      _id: item._id,
      name: typeof item.name === 'string' ? item.name : '',
      description: typeof item.description === 'string' ? item.description : '',
      isPinned: item.isPinned,
    }));
  }

  function transformPayload(body, meta) {
    let next = body;
    if (sortingEnabled() && libraryRuntime.accepts(meta)) next = meta.target === 'me' ? transformMePayload(body, ranks) : transformChatPayload(body, ranks);
    return meta.target === 'chat' ? libraryRuntime.transformChat(next, meta) : libraryRuntime.transformMe(next, meta);
  }

  function installXHRHook() {
    const requests = new WeakMap();
    let proto, openDescriptor, textDescriptor, responseDescriptor;
    try {
      proto = window.XMLHttpRequest.prototype;
      openDescriptor = Object.getOwnPropertyDescriptor(proto, 'open');
      textDescriptor = Object.getOwnPropertyDescriptor(proto, 'responseText');
      responseDescriptor = Object.getOwnPropertyDescriptor(proto, 'response');
      if (!openDescriptor || typeof openDescriptor.value !== 'function' ||
          (!openDescriptor.configurable && !openDescriptor.writable) ||
          !textDescriptor?.configurable || typeof textDescriptor.get !== 'function' || textDescriptor.set) {
        throw new Error('descriptor');
      }
    } catch {
      warnOnce('hook', 'sorter interceptor unavailable; using Crack default order');
      return false;
    }

    const originalOpen = openDescriptor.value;
    const originalText = textDescriptor.get;
    const originalResponse = responseDescriptor?.get;

    function eligible(xhr, meta) {
      if (!hookActive || !meta || xhr.readyState !== 4 || xhr.status < 200 || xhr.status >= 300) return false;
      // A redirect to any other endpoint must not receive this transformation.
      if (xhr.responseURL && identifyTargetRequest('GET', xhr.responseURL) !== meta.target) return false;
      return true;
    }

    function readText(xhr, raw) {
      const meta = requests.get(xhr);
      if (!eligible(xhr, meta) || !libraryRuntime.accepts(meta)) return raw;
      if (meta.textCache?.raw === raw && meta.textCache.version === orderVersion) return meta.textCache.value;
      // Capture native chat data even when global sorting is disabled.
      let value = raw;
      try {
        let body;
        if (meta.parsedText?.raw === raw) body = meta.parsedText.body;
        else {
          body = JSON.parse(raw);
          meta.parsedText = { raw, body };
          if (meta.target === 'me' && libraryRuntime.accepts(meta)) captureLatestMeSnapshot(body, meta.sequence);
          libraryRuntime.observe(body, meta);
        }
        const next = transformPayload(body, meta);
        if (next !== body) value = JSON.stringify(next);
      } catch {
        if (meta.target === 'me' && libraryRuntime.accepts(meta) && meta.sequence >= latestMeSequence) {
          latestMeSequence = meta.sequence;
          latestMeSnapshot = null;
        }
        warnOnce('transform', 'transform skipped; using original response');
      }
      meta.textCache = { raw, version: orderVersion, value };
      return value;
    }

    function wrappedOpen(...args) {
      // Set metadata BEFORE native open: synchronous OPENED listeners can read
      // the XHR or send a synchronous request. A reused XHR gets fresh caches.
      const previous = requests.get(this);
      requests.delete(this);
      let meta = null;
      try {
        const target = identifyTargetRequest(args[0], args[1]);
        if (target) {
          meta = { ...libraryRuntime.captureRequest(target, args[1]), target, sequence: ++requestSequence };
          requests.set(this, meta);
        }
      } catch { /* Only interception failure is swallowed. */ }
      try {
        return Reflect.apply(originalOpen, this, args);
      } catch (error) {
        if (requests.get(this) === meta) {
          requests.delete(this);
          if (previous) requests.set(this, previous);
        }
        throw error;
      }
    }

    function wrappedText() {
      // Native brand/type exceptions must propagate unchanged, not be caught.
      const raw = Reflect.apply(originalText, this, []);
      try { return readText(this, raw); } catch { return raw; }
    }

    function wrappedResponse() {
      const raw = Reflect.apply(originalResponse, this, []);
      try {
        if (this.responseType === '' || this.responseType === 'text') return readText(this, raw);
        const meta = requests.get(this);
        if (this.responseType !== 'json' || !eligible(this, meta) || !libraryRuntime.accepts(meta)) return raw;
        if (meta.jsonCache?.raw === raw && meta.jsonCache.version === orderVersion) return meta.jsonCache.value;
        if (meta.jsonCaptured !== raw) {
          if (meta.target === 'me' && libraryRuntime.accepts(meta)) captureLatestMeSnapshot(raw, meta.sequence);
          libraryRuntime.observe(raw, meta);
          meta.jsonCaptured = raw;
        }
        const value = transformPayload(raw, meta);
        meta.jsonCache = { raw, version: orderVersion, value };
        return value;
      } catch { return raw; }
    }

    // Patch transactionally. Wrappers are inert until every required patch is
    // installed. Preserve all descriptor flags and any earlier wrapper.
    const patches = [];
    try {
      Object.defineProperty(proto, 'responseText', { ...textDescriptor, get: wrappedText });
      patches.push(['responseText', textDescriptor]);
      Object.defineProperty(proto, 'open', { ...openDescriptor, value: wrappedOpen });
      patches.push(['open', openDescriptor]);
      if (responseDescriptor?.configurable && typeof originalResponse === 'function' && !responseDescriptor.set) {
        try {
          Object.defineProperty(proto, 'response', { ...responseDescriptor, get: wrappedResponse });
          patches.push(['response', responseDescriptor]);
        } catch {
          // Optional future JSON support; the proven responseText path works.
          warnOnce('response-hook', 'optional response interceptor unavailable; responseText only');
        }
      }
      hookActive = true;
      return true;
    } catch {
      hookActive = false;
      for (const [key, descriptor] of patches.reverse()) {
        try { Object.defineProperty(proto, key, descriptor); } catch { /* Remaining wrappers are inert. */ }
      }
      warnOnce('hook', 'sorter interceptor unavailable; using Crack default order');
      return false;
    }
  }

  function buildMasterOrderFromEditedGroups(snapshot, groups) {
    const available = new Map(snapshot.map(item => [item._id, item.isPinned]));
    const edited = [...groups.pinned, ...groups.normal];
    if (edited.length !== snapshot.length || new Set(edited).size !== edited.length) throw new Error('stale');
    for (const [pin, ids] of [[true, groups.pinned], [false, groups.normal]]) {
      for (const id of ids) if (!available.has(id) || available.get(id) !== pin) throw new Error('stale');
    }
    const cursor = { pinned: 0, normal: 0 };
    return snapshot.map(item => {
      const group = item.isPinned ? 'pinned' : 'normal';
      return groups[group][cursor[group]++];
    });
  }

  function sameSnapshotSlots(left, right) {
    return Array.isArray(right) && left.length === right.length && left.every((item, index) =>
      item._id === right[index]._id && item.isPinned === right[index].isPinned);
  }

  const UI_CSS = `    :host{color-scheme:light;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;--bg:#fff;--fg:#242834;--muted:#606977;--line:#d9deea;--row:#f6f7fb;--button:#fff;--hover:#eee9fb;--accent:#6444bb;--accent-hover:#51339f;--accent-fg:#fff;--focus:#7254c5;--status:#805019;--backdrop:#18223870;--shadow:#17213b30;color:var(--fg)}
    :host([data-crack-theme="dark"]){color-scheme:dark;--bg:#1b1e27;--fg:#edf0f7;--muted:#aeb6c6;--line:#404757;--row:#242937;--button:#252a37;--hover:#37304b;--accent:#b49af4;--accent-hover:#c4aff9;--accent-fg:#201531;--focus:#b9a1f8;--status:#f0ca91;--backdrop:#070b14b8;--shadow:#0008}
    *{box-sizing:border-box}dialog{color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:16px;padding:0;width:min(640px,calc(100vw - 24px));max-width:none;max-height:calc(100dvh - 24px);margin:auto;box-shadow:0 16px 64px var(--shadow)}dialog::backdrop{background:var(--backdrop)}
    .frame{display:flex;flex-direction:column;max-height:calc(100dvh - 28px)}header{padding:18px 20px 12px;flex:none}h2{font-size:20px;margin:0 0 8px}p{margin:6px 0;line-height:1.5;font-size:13px}.scroll{overflow:auto;padding:0 20px 16px;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--line) transparent}h3{font-size:15px;margin:14px 0 8px}ol{padding:0;margin:0;list-style:none}
    li{display:flex;align-items:center;gap:8px;min-height:56px;padding:8px;margin:5px 0;border:1px solid var(--line);border-radius:9px;background:var(--row)}li.dragging{outline:2px solid var(--focus);opacity:.75}.text{flex:1;min-width:0;overflow-wrap:anywhere}.name{font-size:14px;font-weight:600}.description{font-size:12px;color:var(--muted);white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    button{font:inherit;font-size:13px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--button);color:var(--fg);cursor:pointer}button:hover:enabled{background:var(--hover)}button:focus-visible{outline:3px solid var(--focus);outline-offset:2px}button:disabled{opacity:.4;cursor:default}.handle{cursor:grab;touch-action:none;user-select:none;font-size:18px;padding:8px}.moves{display:flex;gap:4px;flex:none}.moves button{padding:7px 9px}.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}.primary:hover:enabled{background:var(--accent-hover);border-color:var(--accent-hover)}
    footer{padding:12px 20px 16px;border-top:1px solid var(--line);background:var(--row);flex:none}.actions{display:flex;flex-wrap:wrap;gap:8px}.status{min-height:20px;color:var(--status)}.confirm{border:1px solid var(--focus);border-radius:8px;padding:10px;margin-bottom:12px;background:var(--row)}[hidden]{display:none!important}
    @media(max-width:380px){header,footer{padding-inline:12px}.scroll{padding-inline:12px}li{gap:4px;padding:5px}}

  `;

  function element(tag, attributes = {}, text = '') {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text) node.textContent = text;
    return node;
  }

  function openSorterUI(owner, returnFocus) {
    if (activeEditor) { activeEditor.focus(); return; }
    const snapshot = latestMeSnapshot?.map(item => ({ ...item })) ?? null;
    const editorOrderVersion = orderVersion;
    const host = element('div', { 'data-crack-shortcut-sorter-editor': '' });
    owner.append(host);
    const stopTheme = libraryUIFollowTheme(host);
    const root = host.attachShadow({ mode: 'open' });
    root.append(element('style', {}, UI_CSS));
    const dialog = element('dialog', { 'aria-labelledby': 'sorter-title', 'aria-describedby': 'sorter-help' });
    const frame = element('div', { class: 'frame' });
    const header = element('header');
    header.append(element('h2', { id: 'sorter-title' }, '단축어 순서 변경'),
      element('p', { id: 'sorter-help' }, '같은 그룹 안에서 ☰ 핸들을 드래그하거나 ▲ ▼ 버튼으로 이동하세요.'));
    const scroll = element('div', { class: 'scroll' });
    const footer = element('footer');
    const status = element('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const actions = element('div', { class: 'actions' });
    const reset = element('button', { type: 'button' }, '기본 순서 복원');
    const cancel = element('button', { type: 'button' }, '취소');
    const save = element('button', { type: 'button' }, '저장');
    const reload = element('button', { type: 'button', class: 'primary' }, '저장 후 새로고침');
    const confirm = element('section', { class: 'confirm', hidden: '', 'aria-label': '기본 순서 복원 확인' });
    confirm.append(element('p', {}, '사용자 순서를 지우고 Crack 기본 순서로 복원할까요?'));
    const confirmActions = element('div', { class: 'actions' });
    const restore = element('button', { type: 'button' }, '복원');
    const restoreReload = element('button', { type: 'button' }, '복원 후 새로고침');
    const keep = element('button', { type: 'button' }, '돌아가기');
    confirmActions.append(restore, restoreReload, keep);
    confirm.append(confirmActions);
    actions.append(reset, cancel, save, reload);
    footer.append(confirm, status, actions);
    frame.append(header, scroll, footer);
    dialog.append(frame);
    root.append(dialog);

    const controller = new AbortController();
    const listen = (node, type, fn, options = {}) => node.addEventListener(type, fn, { ...options, signal: controller.signal });
    const groups = { pinned: [], normal: [] };
    const lists = {};
    const rows = new Map();
    let drag = null;
    let closed = false;

    function endDrag(revert = false) {
      if (!drag) return;
      const current = drag;
      drag = null;
      if (revert && current.started) groups[current.group] = current.before;
      try {
        if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
      } catch { /* Capture may already have been released by the browser. */ }
      rows.get(current.id)?.classList.remove('dragging');
      dialog.style.userSelect = '';
      if (revert && current.started) renderGroup(current.group);
    }

    function close() {
      if (closed) return;
      closed = true;
      endDrag(true);
      controller.abort();
      stopTheme();
      if (dialog.open) dialog.close();
      host.remove();
      activeEditor = null;
      if (returnFocus?.isConnected) returnFocus.focus();
    }

    function renderGroup(group) {
      const list = lists[group];
      if (!list) return;
      let anchor = null;
      // Never detach/move the row holding pointer capture. Move its siblings
      // around it instead, so mouse/touch dragging survives each reorder.
      for (const id of groups[group].slice().reverse()) {
        const row = rows.get(id);
        if (!(drag?.group === group && drag.id === id)) list.insertBefore(row, anchor);
        anchor = row;
      }
      groups[group].forEach((id, index) => {
        const row = rows.get(id);
        row.querySelector('[data-move="up"]').disabled = index === 0;
        row.querySelector('[data-move="down"]').disabled = index === groups[group].length - 1;
      });
    }

    function move(group, id, to) {
      const ids = groups[group];
      const from = ids.indexOf(id);
      if (from < 0 || to < 0 || to >= ids.length || from === to) return;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      renderGroup(group);
      status.textContent = `${group === 'pinned' ? '고정' : '일반'} 그룹: ${to + 1}번째로 이동했습니다.`;
    }

    if (!hookActive) {
      scroll.append(element('p', {}, '이 환경에서는 안전한 응답 처리를 사용할 수 없습니다. Crack 기본 순서를 유지합니다.'));
      save.disabled = reload.disabled = true;
    } else if (!snapshot) {
      scroll.append(element('p', {}, '단축어 데이터를 불러오는 중입니다. 내 단축어 목록을 다시 열어주세요.'));
      save.disabled = reload.disabled = true;
    } else {
      const ordered = sortingEnabled() ? reorderSamePinSlots(snapshot, ranks) : snapshot;
      for (const group of ['pinned', 'normal']) {
        const pin = group === 'pinned';
        groups[group] = ordered.filter(item => item.isPinned === pin).map(item => item._id);
        const section = element('section', { 'aria-label': pin ? '고정 단축어' : '일반 단축어' });
        section.append(element('h3', {}, pin ? '고정' : '일반'));
        const list = element('ol');
        lists[group] = list;
        section.append(list);
        scroll.append(section);
        if (!groups[group].length) section.append(element('p', {}, '이 그룹에 단축어가 없습니다.'));
        for (const item of ordered.filter(entry => entry.isPinned === pin)) {
          const label = item.name ? (item.name.startsWith('/') ? item.name : `/${item.name}`) : '(이름 없음)';
          const row = element('li');
          const handle = element('button', { type: 'button', class: 'handle', 'aria-label': `${label} 순서 이동 핸들` }, '☰');
          const text = element('div', { class: 'text' });
          text.append(element('div', { class: 'name' }, label));
          if (item.description) text.append(element('div', { class: 'description' }, item.description));
          const moves = element('div', { class: 'moves' });
          const up = element('button', { type: 'button', 'data-move': 'up', 'aria-label': `${label} 위로 이동` }, '▲');
          const down = element('button', { type: 'button', 'data-move': 'down', 'aria-label': `${label} 아래로 이동` }, '▼');
          moves.append(up, down);
          row.append(handle, text, moves);
          rows.set(item._id, row);
          listen(up, 'click', () => {
            endDrag(true);
            move(group, item._id, groups[group].indexOf(item._id) - 1);
            (up.disabled ? down : up).focus();
          });
          listen(down, 'click', () => {
            endDrag(true);
            move(group, item._id, groups[group].indexOf(item._id) + 1);
            (down.disabled ? up : down).focus();
          });
          listen(handle, 'pointerdown', event => {
            if (event.button !== 0 || !event.isPrimary || drag) return;
            event.preventDefault();
            handle.focus();
            try { handle.setPointerCapture(event.pointerId); } catch { return; }
            drag = { group, id: item._id, handle, pointerId: event.pointerId,
              x: event.clientX, y: event.clientY, started: false, before: groups[group].slice() };
          });
        }
        renderGroup(group);
      }
      scroll.append(element('p', {}, '저장된 순서는 다음 정상 목록 요청부터 적용됩니다. 바로 적용하려면 저장 후 새로고침을 선택하세요.'));
    }

    listen(dialog, 'pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.started) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
        drag.started = true;
        rows.get(drag.id).classList.add('dragging');
        dialog.style.userSelect = 'none';
      }
      event.preventDefault();
      const list = lists[drag.group];
      const bounds = list.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
      const viewport = scroll.getBoundingClientRect();
      if (event.clientY < viewport.top + 40) scroll.scrollTop -= 14;
      else if (event.clientY > viewport.bottom - 40) scroll.scrollTop += 14;
      const candidates = groups[drag.group].filter(id => id !== drag.id);
      let to = candidates.length;
      for (let index = 0; index < candidates.length; index += 1) {
        const box = rows.get(candidates[index]).getBoundingClientRect();
        if (event.clientY < box.top + box.height / 2) { to = index; break; }
      }
      // Reorder sibling rows, but retain the captured handle in the DOM.
      // Unexpected capture loss cancels safely and restores the pre-drag order.
      move(drag.group, drag.id, to);
    });
    listen(dialog, 'pointerup', event => { if (drag?.pointerId === event.pointerId) endDrag(); });
    listen(dialog, 'pointercancel', event => { if (drag?.pointerId === event.pointerId) endDrag(true); });
    listen(dialog, 'lostpointercapture', event => { if (drag?.pointerId === event.pointerId) endDrag(true); });
    listen(window, 'blur', () => endDrag(true));
    listen(dialog, 'cancel', event => { event.preventDefault(); close(); });
    listen(dialog, 'close', close);
    listen(dialog, 'keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (drag) endDrag(true);
        else if (!confirm.hidden) { confirm.hidden = true; reset.focus(); }
        else close();
      } else if (event.key === 'Tab') {
        // Native modal focus isolation + explicit traversal inside this shadow.
        const controls = [...dialog.querySelectorAll('button:not(:disabled)')]
          .filter(button => !button.closest('[hidden]'));
        const index = controls.indexOf(root.activeElement);
        const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
        if (controls[next]) { event.preventDefault(); controls[next].focus(); }
      }
      event.stopPropagation();
    });
    for (const type of ['keyup', 'keypress', 'click', 'pointerdown', 'pointermove', 'pointerup']) {
      listen(host, type, event => event.stopPropagation());
    }
    listen(cancel, 'click', close);
    listen(reset, 'click', () => { endDrag(true); confirm.hidden = false; restore.focus(); });
    listen(keep, 'click', () => { confirm.hidden = true; reset.focus(); });

    async function persist(shouldReload) {
      endDrag();
      if (!snapshot || !hookActive) return;
      if (editorOrderVersion !== orderVersion || !sameSnapshotSlots(snapshot, latestMeSnapshot)) {
        status.textContent = '편집 중 목록 또는 저장된 순서가 변경되었습니다. 취소 후 순서 변경을 다시 열어주세요.';
        return;
      }
      let masterOrder;
      try { masterOrder = buildMasterOrderFromEditedGroups(latestMeSnapshot, groups); }
      catch { status.textContent = '목록이 변경되었습니다. 취소 후 다시 열어주세요.'; return; }
      if (!await saveSettings({ schemaVersion: 1, enabled: true, masterOrder })) {
        status.textContent = '브라우저 저장소에 저장하지 못했습니다. 저장소 설정을 확인해 주세요.';
        return;
      }
      close();
      if (shouldReload) window.location.reload();
    }
    async function restoreDefaults(shouldReload) {
      // Omit masterOrder entirely; validation normalises disabled state in memory.
      if (!await saveSettings({ schemaVersion: 1, enabled: false })) {
        status.textContent = '브라우저 저장소에 저장하지 못했습니다. 복원되지 않았습니다.';
        return;
      }
      close();
      if (shouldReload) window.location.reload();
    }
    listen(save, 'click', () => persist(false));
    listen(reload, 'click', () => persist(true));
    listen(restore, 'click', () => restoreDefaults(false));
    listen(restoreReload, 'click', () => restoreDefaults(true));
    activeEditor = { owner, close, focus: () => cancel.focus() };
    try {
      dialog.showModal();
      cancel.focus();
    } catch {
      close();
      warnOnce('editor', 'sorter editor unavailable in this environment');
    }
  }

  function findShortcutTitle(dialog) {
    const exact = node => node?.textContent?.trim() === '내 단축어';
    const labelled = (dialog.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => id && document.getElementById(id)).find(node => node && dialog.contains(node) && exact(node));
    if (labelled) return labelled;
    const heading = [...dialog.querySelectorAll('h1,h2,h3,h4,[role="heading"]')].find(exact);
    if (heading) return heading;
    // A conservative exact-text fallback, without site classes or child indices.
    return [...dialog.querySelectorAll('p,span,div')].find(node => exact(node) && node.children.length === 0) || null;
  }

  function observeShortcutModal() {
    let scheduled = null;
    let lastPath = '';
    const themeBindings = new Map();
    function cleanThemes() {
      for (const [host, stop] of themeBindings) {
        if (!host.isConnected) { stop(); themeBindings.delete(host); }
      }
    }
    const onSettings = () => window.location.pathname === '/setting/chat' || window.location.pathname === '/setting/chat/';
    function scan() {
      scheduled = null;
      cleanThemes();
      if (activeEditor && (!activeEditor.owner.isConnected || !onSettings() ||
          !activeEditor.owner.getClientRects().length || activeEditor.owner.getAttribute('aria-hidden') === 'true')) activeEditor.close();
      if (!onSettings()) {
        document.querySelectorAll(`[${CONTROL}]`).forEach(control => control.remove());
        cleanThemes();
        return;
      }
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        if (!dialog.getClientRects().length || dialog.getAttribute('aria-hidden') === 'true') continue;
        const title = findShortcutTitle(dialog);
        if (!title || dialog.querySelector(`[${CONTROL}]`)) continue;
        const host = element('span', { [CONTROL]: '' });
        const shadow = host.attachShadow({ mode: 'open' });
        themeBindings.set(host, libraryUIFollowTheme(host));
        shadow.append(element('style', {}, ':host{display:inline-block;margin:6px 0;color-scheme:inherit}button{font:inherit;font-size:12px;padding:6px 10px;border:1px solid #8888;border-radius:8px;cursor:pointer;color:CanvasText;background:Canvas}button:focus-visible{outline:2px solid #9865dd}'));
        const button = element('button', { type: 'button' }, '↕ 순서 변경');
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          openSorterUI(dialog, button);
        });
        shadow.append(button);
        const libraryButton = element('button', {type:'button'}, '단축어 관리');
        libraryButton.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation(); void openLibraryUI(libraryButton);
        });
        shadow.append(libraryButton);
        title.after(host);
      }
    }
    function schedule() {
      if (scheduled !== null) return;
      scheduled = window.setTimeout(() => {
        try { scan(); } catch { warnOnce('ui', 'sorter control unavailable'); }
      }, 120);
    }
    // Permanent observation is direct body childList ONLY. No attributes,
    // characterData, or body subtree monitoring. A low-frequency settings-only
    // scan handles portals inserted deeper in existing SPA containers.
    const observer = new MutationObserver(() => { if (onSettings() || activeEditor) schedule(); });
    observer.observe(document.body, { childList: true });
    document.addEventListener('click', () => { if (onSettings()) schedule(); }, true);
    window.addEventListener('popstate', schedule);
    window.addEventListener('pageshow', schedule);
    window.setInterval(() => {
      const path = window.location.pathname;
      if (path !== lastPath || onSettings() || activeEditor) schedule();
      lastPath = path;
    }, 1500);
    schedule();
  }

  // Local library storage. This module has no DOM, HTTP, or server mutations.
  const LibraryCore = (() => {
    const FORMAT = 'crack-shortcut-library';
    const SCHEMA_VERSION = 2;
    const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
    const STORES = ['Library', 'ChatProfiles', 'GlobalSettings', 'SyncState'];
    const POISON = new Set(['__proto__', 'prototype', 'constructor']);
    const LOCAL_ID = /^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const now = () => new Date().toISOString();
    function fail(message, code = 'INVALID_DATA') {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
    function assert(condition, message, code) { if (!condition) fail(message, code); }
    function safe(value, depth = 0, seen = new Set()) {
      assert(depth <= 64, '데이터의 중첩 깊이가 너무 큽니다.');
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
      if (typeof value === 'number') { assert(Number.isFinite(value), '유효하지 않은 숫자입니다.'); return; }
      assert(typeof value === 'object', 'JSON으로 저장할 수 없는 데이터입니다.');
      assert(!seen.has(value), '순환 참조가 있는 데이터입니다.');
      const proto = Object.getPrototypeOf(value);
      assert(Array.isArray(value) || proto === Object.prototype || proto === null, '일반 JSON 객체만 허용됩니다.');
      seen.add(value);
      for (const key of Object.keys(value)) {
        assert(!POISON.has(key), '허용되지 않는 데이터 키입니다.');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        assert(descriptor && own(descriptor, 'value'), '접근자 속성은 허용되지 않습니다.');
        safe(descriptor.value, depth + 1, seen);
      }
      seen.delete(value);
    }
    function clone(value) { safe(value); return JSON.parse(JSON.stringify(value)); }
    function keys(value, allowed, context) {
      assert(record(value), `${context}: 객체가 필요합니다.`);
      assert(Object.keys(value).every(key => allowed.includes(key)), `${context}: 알 수 없는 필드입니다.`);
    }
    function textValue(value, maximum, context, required = false) {
      assert(typeof value === 'string' && value.length <= maximum, `${context}: 문자열 형식 또는 길이가 잘못되었습니다.`);
      if (required) assert(value.trim().length > 0 && value.trim() === value, `${context}: 앞뒤 공백 없는 값이 필요합니다.`);
    }
    function idValue(value, context) { textValue(value, 500, context, true); }
    function timestamp(value, context) {
      textValue(value, 40, context, true);
      assert(Number.isFinite(Date.parse(value)), `${context}: 유효하지 않은 시각입니다.`);
    }
    function nameKey(value) { return value.normalize('NFKC').trim().toLowerCase(); }
    function uuid() {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      assert(typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function', '안전한 로컬 ID를 생성할 수 없습니다.', 'CRYPTO_UNAVAILABLE');
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    function newState() {
      return { revision: 0, library: [], profiles: [], settings: { schemaVersion: SCHEMA_VERSION, defaultIds: [], executionMode: 'unverified', legacy: {} }, sync: {} };
    }
    function validateEntry(entry) {
      keys(entry, ['id', 'serverId', 'name', 'description', 'body', 'isPinned', 'extra', 'source', 'dirty', 'createdAt', 'updatedAt'], '단축어');
      assert(typeof entry.id === 'string' && LOCAL_ID.test(entry.id), '유효하지 않은 로컬 단축어 ID입니다.');
      assert(entry.serverId === null || typeof entry.serverId === 'string', '서버 원본 ID 형식이 잘못되었습니다.');
      if (entry.serverId !== null) idValue(entry.serverId, '서버 원본 ID');
      textValue(entry.name, 200, '단축어 이름', true);
      textValue(entry.description, 20000, '단축어 설명');
      textValue(entry.body, 2 * 1024 * 1024, '단축어 본문');
      assert(typeof entry.isPinned === 'boolean' && typeof entry.dirty === 'boolean', '단축어 상태 형식이 잘못되었습니다.');
      assert(record(entry.extra), '실행 설정 형식이 잘못되었습니다.');
      assert(entry.source === null || record(entry.source), '서버 원본 형식이 잘못되었습니다.');
      timestamp(entry.createdAt, '생성 시각');
      timestamp(entry.updatedAt, '수정 시각');
    }
    function validateIds(ids, byId, context) {
      assert(Array.isArray(ids), `${context}: 단축어 목록이 필요합니다.`);
      assert(ids.length <= 50, `${context}: 활성 단축어는 최대 50개입니다.`, 'ACTIVE_LIMIT');
      const seenIds = new Set();
      const seenNames = new Set();
      for (const id of ids) {
        assert(typeof id === 'string' && byId.has(id), `${context}: 라이브러리에 없는 단축어입니다.`, 'MISSING_REFERENCE');
        assert(!seenIds.has(id), `${context}: 동일 단축어가 중복되었습니다.`);
        const normalized = nameKey(byId.get(id).name);
        assert(!seenNames.has(normalized), `${context}: 호출 이름이 중복됩니다 (${byId.get(id).name}).`, 'NAME_COLLISION');
        seenIds.add(id);
        seenNames.add(normalized);
      }
    }
    function validatePins(pinnedIds, activeIds, context) {
      assert(Array.isArray(pinnedIds) && pinnedIds.length <= 50, `${context}: 고정 목록이 잘못되었습니다.`);
      const active = new Set(activeIds);
      assert(pinnedIds.every(id => typeof id === 'string' && active.has(id)) && new Set(pinnedIds).size === pinnedIds.length, `${context}: 고정 단축어는 활성 목록의 중복 없는 부분집합이어야 합니다.`);
    }
    function validateState(value) {
      const state = clone(value);
      keys(state, ['revision', 'library', 'profiles', 'settings', 'sync'], '라이브러리');
      assert(Number.isSafeInteger(state.revision) && state.revision >= 0, '저장 리비전이 잘못되었습니다.');
      assert(Array.isArray(state.library) && Array.isArray(state.profiles), '라이브러리 또는 프리셋 형식이 잘못되었습니다.');
      const byId = new Map();
      const serverIds = new Set();
      for (const entry of state.library) {
        validateEntry(entry);
        assert(!byId.has(entry.id), '로컬 단축어 ID가 중복되었습니다.');
        if (entry.serverId !== null) {
          assert(!serverIds.has(entry.serverId), '서버 원본 ID가 중복되었습니다.');
          serverIds.add(entry.serverId);
        }
        byId.set(entry.id, entry);
      }
      keys(state.settings, ['schemaVersion', 'defaultIds', 'defaultPinnedIds', 'executionMode', 'legacy'], '전역 설정');
      assert(state.settings.schemaVersion === SCHEMA_VERSION, '지원되지 않는 라이브러리 스키마입니다.');
      textValue(state.settings.executionMode, 100, '실행 방식', true);
      assert(record(state.settings.legacy) && record(state.sync), '기존 설정 또는 동기화 상태 형식이 잘못되었습니다.');
      validateIds(state.settings.defaultIds, byId, '기본 프리셋');
      if (own(state.settings, 'defaultPinnedIds')) validatePins(state.settings.defaultPinnedIds, state.settings.defaultIds, '기본 프리셋');
      const chats = new Set();
      for (const item of state.profiles) {
        keys(item, ['chatId', 'activeIds', 'pinnedIds', 'updatedAt'], '채팅방 프리셋');
        idValue(item.chatId, '채팅방 ID');
        assert(!chats.has(item.chatId), '채팅방 프리셋이 중복되었습니다.');
        chats.add(item.chatId);
        validateIds(item.activeIds, byId, `채팅방 ${item.chatId}`);
        if (own(item, 'pinnedIds')) validatePins(item.pinnedIds, item.activeIds, `채팅방 ${item.chatId}`);
        timestamp(item.updatedAt, '프리셋 수정 시각');
      }
      return state;
    }
    function createEntry(input, existing = null) {
      assert(record(input), '단축어 입력이 필요합니다.');
      safe(input);
      if (existing !== null) validateEntry(clone(existing));
      const stamp = now();
      const entry = {
        id: existing ? existing.id : `local:${uuid()}`,
        serverId: existing ? existing.serverId : null,
        name: input.name,
        description: input.description === undefined ? '' : input.description,
        body: input.body === undefined ? '' : input.body,
        isPinned: input.isPinned === undefined ? false : input.isPinned,
        extra: clone(input.extra === undefined ? (existing ? existing.extra : {}) : input.extra),
        source: clone(existing ? existing.source : (input.source === undefined ? null : input.source)),
        dirty: true,
        createdAt: existing ? existing.createdAt : stamp,
        updatedAt: stamp
      };
      validateEntry(entry);
      return entry;
    }
    function profile(state, chatId) {
      if (chatId !== null && chatId !== undefined) idValue(chatId, '채팅방 ID');
      const global = chatId === null || chatId === undefined;
      const item = state.profiles.find(candidate => candidate.chatId === chatId);
      const activeIds = item ? item.activeIds : state.settings.defaultIds;
      const configured = item ? item.pinnedIds : state.settings.defaultPinnedIds;
      const byId = new Map(state.library.map(entry => [entry.id, entry]));
      const pinnedIds = configured === undefined ? activeIds.filter(id => byId.has(id) && byId.get(id).isPinned) : configured.slice();
      return item ? { ...clone(item), pinnedIds, inherited: false } : { chatId: global ? null : chatId, activeIds: activeIds.slice(), pinnedIds, updatedAt: null, inherited: !global };
    }
    function updateProfile(value, chatId, activeIds, pinnedIds) {
      const state = validateState(value);
      if (chatId !== null && chatId !== undefined) idValue(chatId, '채팅방 ID');
      assert(Array.isArray(activeIds), '활성 단축어 목록이 필요합니다.');
      const previous = profile(state, chatId);
      const previousIds = new Set(previous.activeIds);
      const previousPins = new Set(previous.pinnedIds);
      const byId = new Map(state.library.map(entry => [entry.id, entry]));
      const effectivePins = pinnedIds === undefined ? activeIds.filter(id => previousIds.has(id) ? previousPins.has(id) : byId.has(id) && byId.get(id).isPinned) : pinnedIds;
      if (chatId === null || chatId === undefined) {
        state.settings.defaultIds = clone(activeIds);
        state.settings.defaultPinnedIds = clone(effectivePins);
        return validateState(state);
      }
      const next = { chatId, activeIds: clone(activeIds), pinnedIds: clone(effectivePins), updatedAt: now() };
      const index = state.profiles.findIndex(item => item.chatId === chatId);
      if (index === -1) state.profiles.push(next);
      else state.profiles[index] = next;
      return validateState(state);
    }
    function importServer(value, fullRecords, mapping) {
      const state = validateState(value);
      assert(record(mapping) && typeof mapping.bodyKey === 'string' && mapping.bodyKey.length > 0, '검증된 서버 본문 필드가 필요합니다.', 'SERVER_SCHEMA_UNVERIFIED');
      safe(mapping);
      const fields = { idKey: '_id', nameKey: 'name', descriptionKey: 'description', pinnedKey: 'isPinned', ...mapping };
      for (const key of [fields.idKey, fields.nameKey, fields.descriptionKey, fields.pinnedKey, fields.bodyKey]) {
        assert(typeof key === 'string' && !POISON.has(key), '서버 필드 매핑이 잘못되었습니다.');
      }
      assert(Array.isArray(fields.extraKeys || []), '추가 서버 필드 목록이 잘못되었습니다.');
      assert((fields.extraKeys || []).every(key => typeof key === 'string' && !POISON.has(key)), '추가 서버 필드 매핑이 잘못되었습니다.');
      const records = clone(fullRecords);
      assert(Array.isArray(records), '서버 단축어 목록이 필요합니다.');
      const seen = new Set();
      const staged = [];
      const stamp = now();
      for (const raw of records) {
        assert(record(raw), '서버 단축어 형식이 잘못되었습니다.');
        const serverId = raw[fields.idKey];
        idValue(serverId, '서버 단축어 ID');
        assert(!seen.has(serverId), '서버 단축어 ID가 중복되었습니다.');
        seen.add(serverId);
        assert(own(raw, fields.bodyKey) && typeof raw[fields.bodyKey] === 'string', '서버 본문 필드가 변경되었습니다.', 'SERVER_SCHEMA_CHANGED');
        const extra = {};
        for (const key of fields.extraKeys || []) if (own(raw, key)) extra[key] = clone(raw[key]);
        const existing = state.library.find(item => item.serverId === serverId);
        if (existing && existing.dirty) continue;
        const entry = {
          id: existing ? existing.id : `local:${uuid()}`,
          serverId,
          name: raw[fields.nameKey],
          description: raw[fields.descriptionKey] === undefined ? '' : raw[fields.descriptionKey],
          body: raw[fields.bodyKey],
          isPinned: raw[fields.pinnedKey],
          extra,
          source: raw,
          dirty: false,
          createdAt: existing ? existing.createdAt : stamp,
          updatedAt: stamp
        };
        validateEntry(entry);
        staged.push(entry);
      }
      const hadLibrary = state.library.length > 0;
      for (const entry of staged) {
        const index = state.library.findIndex(item => item.id === entry.id);
        if (index < 0) state.library.push(entry);
        else state.library[index] = entry;
      }
      const originals = Array.isArray(state.sync.serverOriginals) ? state.sync.serverOriginals : [];
      const originalIds = new Set(originals.map(item => item[fields.idKey]));
      for (const raw of records) if (!originalIds.has(raw[fields.idKey])) originals.push(clone(raw));
      state.sync.serverOriginals = originals;
      state.sync.latestServerRecords = clone(records);
      state.sync.lastImportAt = stamp;
      if (!hadLibrary) {
        const names = new Set();
        state.settings.defaultIds = state.library.filter(entry => {
          const key = nameKey(entry.name);
          if (names.has(key)) return false;
          names.add(key);
          return true;
        }).slice(0, 50).map(entry => entry.id);
        const defaults = new Set(state.settings.defaultIds);
        state.settings.defaultPinnedIds = state.library.filter(entry => defaults.has(entry.id) && entry.isPinned).map(entry => entry.id);
      }
      return validateState(state);
    }
    function migrate(value, v1Settings, serverRecords = [], mapping = { bodyKey: 'prompt' }) {
      let state = validateState(value);
      if (state.sync.migratedV1) return state;
      if (serverRecords.length) state = importServer(state, serverRecords, mapping);
      const legacy = clone(v1Settings);
      keys(legacy, ['schemaVersion', 'enabled', 'masterOrder'], 'v1 설정');
      assert(legacy.schemaVersion === 1 && typeof legacy.enabled === 'boolean', 'v1 설정 형식이 잘못되었습니다.');
      const order = legacy.masterOrder === undefined && !legacy.enabled ? [] : legacy.masterOrder;
      assert(Array.isArray(order) && order.every(id => typeof id === 'string' && id.length > 0 && id.trim() === id) && new Set(order).size === order.length, 'v1 단축어 순서가 잘못되었습니다.');
      state.settings.legacy = { schemaVersion: 1, enabled: legacy.enabled, masterOrder: order.slice() };
      if (state.library.length) {
        const byServer = new Map(state.library.filter(entry => entry.serverId !== null).map(entry => [entry.serverId, entry.id]));
        const ordered = legacy.enabled ? order.filter(id => byServer.has(id)).map(id => byServer.get(id)) : [];
        const all = [...ordered, ...state.library.map(entry => entry.id).filter(id => !ordered.includes(id))];
        const names = new Set();
        const byId = new Map(state.library.map(entry => [entry.id, entry]));
        state.settings.defaultIds = all.filter(id => {
          const key = nameKey(byId.get(id).name);
          if (names.has(key)) return false;
          names.add(key);
          return true;
        }).slice(0, 50);
        state.settings.defaultPinnedIds = state.settings.defaultIds.filter(id => byId.get(id).isPinned);
      }
      state.sync.migratedV1 = true;
      state.sync.migratedV1At = now();
      return validateState(state);
    }
    function byteLength(value) {
      return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(value).byteLength : value.length * 3;
    }
    function validateBackup(value, accountId) {
      const backup = clone(value);
      keys(backup, ['format', 'schemaVersion', 'accountId', 'scope', 'exportedAt', 'state'], '백업');
      assert(backup.format === FORMAT && backup.schemaVersion === SCHEMA_VERSION, '지원되지 않는 백업 형식입니다.');
      if (backup.accountId !== null) idValue(backup.accountId, '백업 계정 ID');
      if (accountId !== undefined) {
        idValue(accountId, '현재 계정 ID');
        assert(backup.accountId !== null, '계정 식별자가 없는 백업은 적용할 수 없습니다.', 'ACCOUNT_UNVERIFIED');
        assert(backup.accountId === accountId, '다른 계정의 백업은 적용할 수 없습니다.', 'ACCOUNT_MISMATCH');
      }
      keys(backup.scope, ['type', 'chatId'], '백업 범위');
      assert(backup.scope.type === 'all' || backup.scope.type === 'chat', '백업 범위가 잘못되었습니다.');
      if (backup.scope.type === 'chat') idValue(backup.scope.chatId, '백업 채팅방 ID');
      else assert(!own(backup.scope, 'chatId'), '전체 백업 범위에 채팅방 ID가 있습니다.');
      timestamp(backup.exportedAt, '백업 시각');
      backup.state = validateState(backup.state);
      if (backup.scope.type === 'chat') {
        assert(backup.state.profiles.length === 1 && backup.state.profiles[0].chatId === backup.scope.chatId, '채팅방 백업의 프리셋 범위가 잘못되었습니다.');
        assert(backup.state.settings.defaultIds.length === 0, '채팅방 백업에 전역 기본 프리셋이 있습니다.');
        assert(!backup.state.settings.defaultPinnedIds || backup.state.settings.defaultPinnedIds.length === 0, '채팅방 백업에 전역 기본 고정 목록이 있습니다.');
        const references = new Set(backup.state.profiles[0].activeIds);
        assert(backup.state.library.every(entry => references.has(entry.id)), '채팅방 백업에 참조되지 않은 단축어가 있습니다.');
      }
      assert(byteLength(JSON.stringify(backup)) <= MAX_BACKUP_BYTES, '백업 파일은 32MB 이하로 가져올 수 있습니다.', 'BACKUP_TOO_LARGE');
      return backup;
    }
    function parseBackup(raw, accountId) {
      assert(typeof raw === 'string', '백업 JSON 문자열이 필요합니다.');
      assert(byteLength(raw) <= MAX_BACKUP_BYTES, '백업 파일은 32MB 이하로 가져올 수 있습니다.', 'BACKUP_TOO_LARGE');
      let parsed;
      try { parsed = JSON.parse(raw); } catch { fail('백업 JSON이 손상되었습니다.', 'CORRUPT_BACKUP'); }
      return validateBackup(parsed, accountId);
    }
    function exportBackup(value, scope = null, accountId = null) {
      let state = validateState(value);
      let chatId = typeof scope === 'string' ? scope : (scope && scope.chatId ? scope.chatId : null);
      if (record(scope) && own(scope, 'accountId')) accountId = scope.accountId;
      if (accountId !== null) idValue(accountId, '백업 계정 ID');
      const range = chatId ? { type: 'chat', chatId } : { type: 'all' };
      if (chatId) {
        const selected = profile(state, chatId);
        const ids = new Set(selected.activeIds);
        state = {
          revision: state.revision,
          library: state.library.filter(entry => ids.has(entry.id)),
          profiles: [{ chatId, activeIds: selected.activeIds, pinnedIds: selected.pinnedIds, updatedAt: selected.updatedAt || now() }],
          settings: { schemaVersion: SCHEMA_VERSION, defaultIds: [], executionMode: 'unverified', legacy: {} },
          sync: {}
        };
      }
      return validateBackup({ format: FORMAT, schemaVersion: SCHEMA_VERSION, accountId, scope: range, exportedAt: now(), state });
    }
    function mergeBackup(value, parsedBackup, mode = 'merge') {
      const current = validateState(value);
      const backup = validateBackup(parsedBackup);
      assert(mode === 'merge' || mode === 'replace', '가져오기 방식이 잘못되었습니다.');
      const incoming = backup.state;
      const conflicts = { entryIds: [], names: [], profiles: [], settings: false, changedEntries: 0, addedEntries: 0 };
      const currentById = new Map(current.library.map(entry => [entry.id, entry]));
      const currentByServer = new Map(current.library.filter(entry => entry.serverId !== null).map(entry => [entry.serverId, entry]));
      const remap = new Map();
      const comparable = entry => JSON.stringify({ name: entry.name, description: entry.description, body: entry.body, isPinned: entry.isPinned, extra: entry.extra, source: entry.source, dirty: entry.dirty });
      for (const entry of incoming.library) {
        const existing = currentById.get(entry.id) || (entry.serverId !== null ? currentByServer.get(entry.serverId) : null);
        remap.set(entry.id, existing ? existing.id : entry.id);
        if (existing) {
          if (comparable(existing) !== comparable(entry)) {
            conflicts.entryIds.push({ id: existing.id, incomingId: entry.id, existingName: existing.name, incomingName: entry.name });
            conflicts.changedEntries += 1;
          }
        } else conflicts.addedEntries += 1;
        const sameNames = current.library.filter(item => nameKey(item.name) === nameKey(entry.name) && item.id !== (existing ? existing.id : entry.id));
        if (sameNames.length) conflicts.names.push({ name: entry.name, existingIds: sameNames.map(item => item.id), incomingId: entry.id });
      }
      for (const item of incoming.profiles) {
        const existing = current.profiles.find(candidate => candidate.chatId === item.chatId);
        const mapped = item.activeIds.map(id => remap.get(id));
        const mappedPins = item.pinnedIds === undefined ? undefined : item.pinnedIds.map(id => remap.get(id));
        if (existing && (JSON.stringify(existing.activeIds) !== JSON.stringify(mapped) || JSON.stringify(existing.pinnedIds) !== JSON.stringify(mappedPins))) conflicts.profiles.push({ chatId: item.chatId, reason: 'different' });
      }
      conflicts.settings = backup.scope.type === 'all' && JSON.stringify(current.settings) !== JSON.stringify(incoming.settings);
      let state;
      if (mode === 'replace' && backup.scope.type === 'all') {
        state = clone(incoming);
      } else {
        state = clone(current);
        for (const entry of incoming.library) {
          const mappedId = remap.get(entry.id);
          const index = state.library.findIndex(item => item.id === mappedId);
          if (index < 0) state.library.push(clone(entry));
          else if (mode === 'replace') state.library[index] = { ...clone(entry), id: mappedId };
        }
        const byId = new Map(state.library.map(entry => [entry.id, entry]));
        for (const item of incoming.profiles) {
          const next = { ...clone(item), activeIds: item.activeIds.map(id => remap.get(id)) };
          if (item.pinnedIds !== undefined) next.pinnedIds = item.pinnedIds.map(id => remap.get(id));
          const index = state.profiles.findIndex(candidate => candidate.chatId === item.chatId);
          if (index >= 0 && mode === 'merge') continue;
          try { validateIds(next.activeIds, byId, `채팅방 ${item.chatId}`); }
          catch (error) {
            if (mode === 'replace') throw error;
            conflicts.profiles.push({ chatId: item.chatId, reason: error.code || 'invalid' });
            continue;
          }
          if (index < 0) state.profiles.push(next);
          else state.profiles[index] = next;
        }
      }
      state.revision = current.revision;
      // A file cannot certify that server execution or server slots are valid now.
      state.settings.executionMode = 'unverified';
      const metadata = clone(state.sync);
      state.sync = { restoredMetadata: metadata, restoreRequiresVerification: true, restoredAt: now() };
      // These are local configuration/provenance, never server slot authority.
      for (const flag of ['migratedV1', 'defaultConfigured']) if (metadata[flag] === true) state.sync[flag] = true;
      for (const rawBackup of ['serverOriginals', 'latestServerRecords']) if (Array.isArray(metadata[rawBackup])) state.sync[rawBackup] = clone(metadata[rawBackup]);
      return { state: validateState(state), conflicts };
    }
    function storageError(error, code = 'STORAGE_FAILURE') {
      const failure = new Error(code === 'REVISION_CONFLICT' ? '다른 탭에서 라이브러리가 변경되었습니다. 다시 불러온 뒤 저장하세요.' : '브라우저 저장소 작업에 실패했습니다. 기존 데이터는 유지됩니다.');
      failure.code = code;
      if (error && error.name) failure.storageName = error.name;
      return failure;
    }
    async function open(accountId) {
      idValue(accountId, '계정 ID');
      assert(typeof indexedDB !== 'undefined' && indexedDB, 'IndexedDB를 사용할 수 없습니다.', 'STORAGE_UNAVAILABLE');
      const dbName = `crack-shortcut-library-v2:${encodeURIComponent(accountId)}`;
      const db = await new Promise((resolve, reject) => {
        let settled = false;
        const request = indexedDB.open(dbName, SCHEMA_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          for (const [name, keyPath] of [['Library', 'id'], ['ChatProfiles', 'chatId'], ['GlobalSettings', 'key'], ['SyncState', 'key']]) {
            if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath });
          }
        };
        request.onerror = () => { settled = true; reject(storageError(request.error)); };
        request.onblocked = () => { settled = true; reject(storageError(null, 'STORAGE_BLOCKED')); };
        request.onsuccess = () => {
          if (settled) { request.result.close(); return; }
          settled = true;
          const database = request.result;
          if (!STORES.every(name => database.objectStoreNames.contains(name))) { database.close(); reject(storageError(null, 'STORAGE_CORRUPT')); return; }
          resolve(database);
        };
      });
      db.onversionchange = () => db.close();
      function load() {
        return new Promise((resolve, reject) => {
          let transaction;
          try { transaction = db.transaction(STORES, 'readonly'); } catch (error) { reject(storageError(error)); return; }
          const results = {};
          let invalid = null;
          for (const [store, action, key] of [['Library', 'getAll'], ['ChatProfiles', 'getAll'], ['GlobalSettings', 'get', 'settings'], ['SyncState', 'get', 'state']]) {
            const request = transaction.objectStore(store)[action](key);
            request.onsuccess = () => { results[store] = request.result; };
          }
          transaction.onerror = () => { invalid = invalid || storageError(transaction.error); };
          transaction.onabort = () => reject(invalid || storageError(transaction.error));
          transaction.oncomplete = () => {
            try {
              const settingsRecord = results.GlobalSettings;
              const syncRecord = results.SyncState;
              if (!settingsRecord && !syncRecord && !results.Library.length && !results.ChatProfiles.length) { resolve(newState()); return; }
              assert(settingsRecord && syncRecord && settingsRecord.key === 'settings' && syncRecord.key === 'state', '저장소 메타데이터가 손상되었습니다.', 'STORAGE_CORRUPT');
              keys(settingsRecord, ['key', 'revision', 'accountId', 'settings'], '저장소 설정');
              keys(syncRecord, ['key', 'sync'], '저장소 동기화');
              assert(settingsRecord.accountId === accountId, '저장소 계정 식별자가 일치하지 않습니다.', 'ACCOUNT_MISMATCH');
              resolve(validateState({ revision: settingsRecord.revision, library: results.Library, profiles: results.ChatProfiles, settings: settingsRecord.settings, sync: syncRecord.sync }));
            } catch (error) { reject(error); }
          };
        });
      }
      function save(value, expectedRevision) {
        let staged;
        try {
          staged = validateState(value);
          assert(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 && staged.revision === expectedRevision, '저장하려는 리비전이 일치하지 않습니다.', 'REVISION_CONFLICT');
          assert(expectedRevision < Number.MAX_SAFE_INTEGER, '저장 리비전 한도를 초과했습니다.');
        } catch (error) { return Promise.reject(error); }
        return new Promise((resolve, reject) => {
          let transaction;
          let reason = null;
          try { transaction = db.transaction(STORES, 'readwrite'); } catch (error) { reject(storageError(error)); return; }
          const settingsStore = transaction.objectStore('GlobalSettings');
          const stored = {};
          let pending = 4;
          const writeAfterRead = () => {
            try {
              const current = stored.GlobalSettings;
              if (current) {
                keys(current, ['key', 'revision', 'accountId', 'settings'], '저장소 설정');
                assert(current.accountId === accountId, '저장소 계정 식별자가 일치하지 않습니다.', 'ACCOUNT_MISMATCH');
                assert(stored.SyncState && stored.SyncState.key === 'state', '저장소 메타데이터가 손상되었습니다.', 'STORAGE_CORRUPT');
                keys(stored.SyncState, ['key', 'sync'], '저장소 동기화');
                validateState({ revision: current.revision, library: stored.Library, profiles: stored.ChatProfiles, settings: current.settings, sync: stored.SyncState.sync });
              } else {
                assert(!stored.SyncState && !stored.Library.length && !stored.ChatProfiles.length, '저장소 메타데이터가 손상되었습니다.', 'STORAGE_CORRUPT');
              }
              assert((current ? current.revision : 0) === expectedRevision, '다른 탭에서 라이브러리가 변경되었습니다. 다시 불러온 뒤 저장하세요.', 'REVISION_CONFLICT');
              staged.revision = expectedRevision + 1;
              const libraryStore = transaction.objectStore('Library');
              const profileStore = transaction.objectStore('ChatProfiles');
              libraryStore.clear();
              profileStore.clear();
              for (const entry of staged.library) libraryStore.put(entry);
              for (const item of staged.profiles) profileStore.put(item);
              settingsStore.put({ key: 'settings', revision: staged.revision, accountId, settings: staged.settings });
              transaction.objectStore('SyncState').put({ key: 'state', sync: staged.sync });
            } catch (error) { reason = typeof error.code === 'string' ? error : storageError(error); transaction.abort(); }
          };
          for (const [store, action, key] of [['Library', 'getAll'], ['ChatProfiles', 'getAll'], ['GlobalSettings', 'get', 'settings'], ['SyncState', 'get', 'state']]) {
            const request = transaction.objectStore(store)[action](key);
            request.onsuccess = () => {
              stored[store] = request.result;
              pending -= 1;
              if (pending === 0) writeAfterRead();
            };
          }
          transaction.onerror = () => { reason = reason || storageError(transaction.error); };
          transaction.onabort = () => reject(reason || storageError(transaction.error));
          transaction.oncomplete = () => resolve(clone(staged));
        });
      }
      return { accountId, dbName, load, save, close: () => db.close() };
    }
    return { FORMAT, SCHEMA_VERSION, MAX_BACKUP_BYTES, newState, createEntry, validateState, profile, updateProfile, importServer, migrate, parseBackup, exportBackup, mergeBackup, open, clone, nameKey };
  })();

  // Public Crack build: _app module 92703 exports its default SWR cache as `c`
  // and the cache-bound mutate function as `j`. Chunk 3790 module 15082 exports
  // `hn.getKey({chatId})` and `TI.getKey`. Chunk 574 modules 88282/28377 consume
  // that exact chat key and revalidate it after native shortcut changes.
  // This bridge changes no React handlers or shortcut IDs and sends no writes.
  const LibraryNativeCache = (() => {
    const PERSONAL_KEY = '/shortcut-commands/me';
    const CHAT_KEY = /^\/shortcut-commands\/chats\/[a-f0-9]{24}$/i;
    const CHAT_ID = /^[a-f0-9]{24}$/i;
    const PROBE_ID = '000000000000000000000000';
    const PRIVATE_DETAIL = /^\/shortcut-commands\/me\/[a-f0-9]{24}$/i;
    const purgedKeys = new Set();
    const captureChunkKey = `crack-shortcut-library-swr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let runtimeRequire = null;
    let captureAttempted = false;
    let verified = null;
    let unavailableReason = 'webpack-runtime-not-ready';

    function allowedKey(key) {
      return typeof key === 'string' && (key === PERSONAL_KEY || CHAT_KEY.test(key));
    }
    function resolve() {
      if (verified) return verified;
      try {
        if (!runtimeRequire) {
          const chunks = window.webpackChunk_N_E;
          // Before the webpack runtime starts, this is an ordinary Array.push;
          // inserting a chunk at that point would not capture its require API.
          if (!Array.isArray(chunks) || typeof chunks.push !== 'function' || chunks.push === Array.prototype.push) {
            unavailableReason = 'webpack-runtime-not-ready';
            return null;
          }
          if (captureAttempted) {
            unavailableReason = 'webpack-runtime-capture-unavailable';
            return null;
          }
          captureAttempted = true;
          Reflect.apply(chunks.push, chunks, [[
            [captureChunkKey], {}, candidate => {
              if (typeof candidate === 'function') runtimeRequire = candidate;
            }
          ]]);
          if (!runtimeRequire) {
            unavailableReason = 'webpack-runtime-capture-unavailable';
            return null;
          }
        }
        // The module factories must already be registered. Do not initialize
        // unavailable modules, scan caches, or insert another capture chunk.
        const factories = runtimeRequire.m;
        if (!factories || typeof factories[92703] !== 'function' || typeof factories[15082] !== 'function') {
          unavailableReason = 'native-modules-not-ready';
          return null;
        }
        const swr = runtimeRequire(92703);
        const api = runtimeRequire(15082);
        const cache = swr?.c;
        if (!cache || typeof cache.get !== 'function' || typeof cache.has !== 'function' ||
            typeof cache.keys !== 'function' || typeof swr.j !== 'function' ||
            !api?.hn || typeof api.hn.getKey !== 'function' || api?.TI?.getKey !== PERSONAL_KEY ||
            api.hn.getKey({ chatId: PROBE_ID }) !== `/shortcut-commands/chats/${PROBE_ID}`) {
          unavailableReason = 'native-module-contract-changed';
          return null;
        }
        verified = { cache, mutate: swr.j, serialize: swr.s, chatKey: api.hn.getKey };
        unavailableReason = '';
        return verified;
      } catch {
        // A changed bundler/module contract must leave Crack's cache intact.
        unavailableReason = 'native-module-contract-unavailable';
        return null;
      }
    }
    function current() {
      return resolve() ? { available: true } : { available: false, reason: unavailableReason };
    }
    function keys(chatId) {
      const bridge = resolve();
      if (!bridge) return { available: false, reason: unavailableReason, chatKey: null, personalKey: null };
      try {
        if (chatId !== null && chatId !== undefined && (typeof chatId !== 'string' || !CHAT_ID.test(chatId))) {
          return { available: false, reason: 'unsupported-chat-id', chatKey: null, personalKey: PERSONAL_KEY };
        }
        const chatKey = chatId ? bridge.chatKey({ chatId }) : null;
        if (chatKey && (!allowedKey(chatKey) || chatKey !== `/shortcut-commands/chats/${chatId}`)) {
          return { available: false, reason: 'native-key-contract-changed', chatKey: null, personalKey: null };
        }
        return { available: true, chatKey, personalKey: PERSONAL_KEY };
      } catch {
        return { available: false, reason: 'native-key-contract-unavailable', chatKey: null, personalKey: null };
      }
    }
    function read(key) {
      if (!allowedKey(key)) return { available: false, present: false, reason: 'unsupported-cache-key' };
      const bridge = resolve();
      if (!bridge) return { available: false, present: false, reason: unavailableReason };
      try {
        const present = bridge.cache.has(key);
        return { available: true, present, entry: present ? bridge.cache.get(key) : undefined };
      } catch {
        return { available: false, present: false, reason: 'native-cache-unavailable' };
      }
    }
    function has(key) { return allowedKey(key) && (read(key).present === true || purgedKeys.has(key)); }
    async function purgePrivate() {
      const bridge = resolve();
      if (!bridge || typeof bridge.cache.delete !== 'function') return {available:false,cleared:0,reason:unavailableReason||'native-cache-delete-unavailable'};
      const targets = [];
      try {
        for (const key of bridge.cache.keys()) {
          const entry = bridge.cache.get(key);
          if (allowedKey(key) || typeof key==='string' && PRIVATE_DETAIL.test(key)) {
            targets.push({key,original:key});
            continue;
          }
          // Official module 45483.F.detail(id) uses this array; SWR's verified
          // serializer must map its original _k back to this exact cache key.
          const original = entry && Object.getOwnPropertyDescriptor(entry,'_k')?.value;
          if (Array.isArray(original) && original.length===3 && original[0]==='slash-command' && original[1]==='detail' &&
              typeof original[2]==='string' && CHAT_ID.test(original[2]) && typeof bridge.serialize==='function' && bridge.serialize(original)[0]===key) targets.push({key,original});
        }
      } catch { return {available:false,cleared:0,reason:'native-private-cache-contract-changed'}; }
      let cleared = 0;
      for (const target of targets) {
        try {
          // Explicit undefined is a cache update, not one-argument revalidation.
          // Notify mounted views without fetching, then remove private metadata.
          await bridge.mutate(target.original,undefined,{revalidate:false});
          bridge.cache.delete(target.key);
          if (allowedKey(target.key)) purgedKeys.add(target.key);
          cleared += 1;
        } catch { return {available:false,cleared,reason:'native-private-cache-clear-failed'}; }
      }
      return {available:true,cleared};
    }
    async function revalidate(key) {
      const before = read(key);
      if (!before.available || !before.present && !purgedKeys.has(key)) return { ...before, revalidated: false, reason: before.reason || 'native-cache-key-not-mounted' };
      const bridge = resolve();
      if (!bridge) return { available: false, present: false, revalidated: false, reason: unavailableReason };
      try {
        // This is the same one-argument mutate(key) used by Crack's native pin
        // action. SWR performs the GET and notifies the existing subscribers.
        // A resolved mutate call is not proof that a shortcut was executed.
        await bridge.mutate(key);
        purgedKeys.delete(key);
        const after = read(key);
        if (!after.available || !after.present) return { ...after, revalidated: false, reason: after.reason || 'native-cache-key-removed' };
        if (after.entry?.error) return { ...after, revalidated: false, reason: 'native-revalidation-failed' };
        return { ...after, revalidated: true };
      } catch {
        return { ...read(key), revalidated: false, reason: 'native-revalidation-failed' };
      }
    }
    return { current, keys, has, read, revalidate, purgePrivate };
  })();

  // Manual, consented server-slot application. Network, account locking and
  // durable persistence belong to the verified runtime adapter.
  const LibrarySync = (() => {
    const FORMAT = 'crack-shortcut-sync-plan';
    const LIMIT = 50;
    const SERVER_ID = /^[0-9a-f]{24}$/i;
    const clone = value => LibraryCore.clone(value);
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const stamp = () => new Date().toISOString();
    function fail(message, code) { const error = new Error(message); error.code = code; throw error; }
    function ensure(value, message, code = 'INVALID_SYNC_DATA') { if (!value) fail(message, code); }
    function stable(value) {
      return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
    }
    function fingerprint(records) { return stable(records.slice().sort((a, b) => a._id.localeCompare(b._id))); }
    function fieldsOf(value) {
      return { name: value.name, description: value.description, prompt: value.prompt, isPublic: value.isPublic };
    }
    function equalFields(left, right) { return stable(fieldsOf(left)) === stable(fieldsOf(right)); }
    function validFields(fields) {
      ensure(typeof fields.name === 'string' && fields.name.length >= 1 && fields.name.length <= 10 && /^\S+$/.test(fields.name), '서버 적용 이름은 공백 없이 1–10자여야 합니다.', 'INVALID_SERVER_FIELDS');
      ensure(typeof fields.description === 'string' && fields.description.trim() && fields.description.length <= 30, '서버 적용 설명은 1–30자여야 합니다.', 'INVALID_SERVER_FIELDS');
      ensure(typeof fields.prompt === 'string' && fields.prompt.trim() && fields.prompt.length <= 400, '서버 적용 본문은 1–400자여야 합니다.', 'INVALID_SERVER_FIELDS');
      ensure(typeof fields.isPublic === 'boolean', '서버 공개 여부가 확인되지 않았습니다.', 'INVALID_SERVER_FIELDS');
    }
    function checkedRecords(input) {
      const records = clone(input);
      ensure(Array.isArray(records) && records.length <= LIMIT, '전체 서버 슬롯 수가 50개 이내인지 확인하지 못했습니다.', 'SERVER_QUOTA_STATE');
      const seen = new Set();
      for (const raw of records) {
        ensure(record(raw) && typeof raw._id === 'string' && SERVER_ID.test(raw._id) && !seen.has(raw._id), '전체 서버 원본 ID가 잘못되었거나 중복되었습니다.', 'SERVER_SCHEMA_CHANGED');
        ensure(typeof raw.name === 'string' && typeof raw.description === 'string' && typeof raw.prompt === 'string' && typeof raw.isPublic === 'boolean' && typeof raw.isPinned === 'boolean', '본문·공개 상태·고정 상태가 포함된 전체 서버 원본이 필요합니다.', 'INCOMPLETE_SERVER_BACKUP');
        seen.add(raw._id);
      }
      return records;
    }
    function contextOf(value, chatId) {
      const ctx = clone(value);
      ensure(record(ctx) && typeof ctx.accountId === 'string' && ctx.accountId.trim() === ctx.accountId && ctx.accountId.length > 0, '확인된 계정 ID가 필요합니다.', 'ACCOUNT_UNVERIFIED');
      ensure(Number.isSafeInteger(ctx.revision) && ctx.revision >= 0 && Number.isSafeInteger(ctx.generation) && ctx.generation >= 0, '저장 리비전과 채팅방 세대가 필요합니다.', 'INVALID_SYNC_CONTEXT');
      ensure(chatId === null || typeof chatId === 'string' && chatId.length > 0, '채팅방 또는 전역 프리셋을 확인하지 못했습니다.', 'INVALID_SYNC_CONTEXT');
      if (own(ctx, 'chatId')) ensure(ctx.chatId === chatId, '미리보기의 채팅방이 일치하지 않습니다.', 'CONTEXT_CHANGED');
      return { accountId: ctx.accountId, revision: ctx.revision, generation: ctx.generation, chatId };
    }
    function protection(raw) {
      if (raw.isPublic === true) return '공개 단축어';
      if (raw.isOwn === false) return '다른 소유자의 단축어';
      if (raw.sourceType !== undefined && raw.sourceType !== 'PERSONAL') return '개인 원본이 아닌 단축어';
      if (raw.adminBlockedAt !== undefined && raw.adminBlockedAt !== null) return '차단된 서버 원본';
      try { validFields(fieldsOf(raw)); } catch { return '안전하게 복원할 수 없는 입력 형식'; }
      return null;
    }
    function extraMatches(entry, raw) {
      return Object.keys(entry.extra).every(key => own(raw, key) && stable(entry.extra[key]) === stable(raw[key]));
    }
    function plan(value, chatId, fullServerRecords, context) {
      const state = LibraryCore.validateState(value);
      // The live repository retains complete journals. A new plan must not
      // recursively copy their old plans/backups into another complete journal.
      if (Array.isArray(state.sync.journals)) {
        state.sync.journalReferences = state.sync.journals.map(journal => {
          const reference = {};
          for (const key of ['id', 'phase', 'startedAt', 'updatedAt', 'finishedAt']) {
            if (typeof journal[key] === 'string') reference[key] = journal[key];
          }
          return reference;
        });
        delete state.sync.journals;
      }
      chatId = chatId === undefined ? null : chatId;
      const ctx = contextOf(context, chatId);
      ensure(state.revision === ctx.revision, '저장된 라이브러리 리비전이 변경되었습니다.', 'REVISION_CONFLICT');
      const originals = checkedRecords(fullServerRecords);
      const selected = LibraryCore.profile(state, chatId);
      const byLocal = new Map(state.library.map(entry => [entry.id, entry]));
      const protectedRows = originals.map(raw => ({ raw, reason: protection(raw) })).filter(item => item.reason);
      const protectedIds = new Set(protectedRows.map(item => item.raw._id));
      // An explicitly retained extra execution setting cannot be replayed by
      // the four-field create API. Such originals may be reused, never deleted.
      for (const entry of state.library) {
        if (entry.serverId && Object.keys(entry.extra).some(key => key !== 'isPublic')) protectedIds.add(entry.serverId);
      }
      const reuses = [], creates = [], removes = [];
      const reusedIds = new Set();
      const deleteIds = new Set();
      const nameKey = LibraryCore.nameKey;
      for (const localId of selected.activeIds) {
        const entry = byLocal.get(localId);
        ensure(typeof entry.extra.isPublic === 'boolean', `“${entry.name}”의 공개 여부 설정이 필요합니다.`, 'UNVERIFIED_EXECUTION_SETTINGS');
        const fields = { name: entry.name, description: entry.description, prompt: entry.body, isPublic: entry.extra.isPublic };
        const exact = originals.find(raw => !reusedIds.has(raw._id) && equalFields(raw, fields) && extraMatches(entry, raw));
        if (exact) {
          ensure(exact.adminBlockedAt === undefined || exact.adminBlockedAt === null, `“${entry.name}”은 서버에서 차단된 원본이므로 실행 연결할 수 없습니다.`, 'ADMIN_BLOCKED');
          reuses.push({ localId, serverId: exact._id, name: entry.name, fields });
          reusedIds.add(exact._id);
          continue;
        }
        ensure(Object.keys(entry.extra).every(key => key === 'isPublic'), `“${entry.name}”의 추가 실행 설정은 서버 생성 API에서 보존할 수 없습니다.`, 'UNSUPPORTED_EXECUTION_SETTINGS');
        validFields(fields);
        creates.push({ localId, name: entry.name, fields });
        for (const raw of originals.filter(item => nameKey(item.name) === nameKey(entry.name))) {
          ensure(!protectedIds.has(raw._id), `보호된 “${raw.name}” 원본과 호출 이름이 충돌합니다. 로컬 이름을 바꾸세요.`, 'PROTECTED_NAME_COLLISION');
          ensure(!reusedIds.has(raw._id), `“${raw.name}”을 유지하면서 같은 이름의 다른 본문을 적용할 수 없습니다.`, 'SERVER_NAME_COLLISION');
          deleteIds.add(raw._id);
        }
      }
      // Include every exact reuse before choosing quota victims.
      ensure([...deleteIds].every(id => !reusedIds.has(id)), '선택된 원본과 삭제 대상이 충돌합니다.', 'SERVER_NAME_COLLISION');
      const needed = Math.max(0, originals.length - deleteIds.size + creates.length - LIMIT);
      const candidates = originals.filter(raw => !protectedIds.has(raw._id) && !reusedIds.has(raw._id) && !deleteIds.has(raw._id));
      ensure(candidates.length >= needed, '공개·다른 소유자·추가 설정이 있는 원본을 보호하면 서버 슬롯이 부족합니다. 선택 수를 줄이세요.', 'PROTECTED_SLOT_LIMIT');
      for (const raw of candidates.slice(0, needed)) deleteIds.add(raw._id);
      const backupEntries = [];
      for (const raw of originals.filter(item => deleteIds.has(item._id))) {
        const reason = creates.some(item => nameKey(item.name) === nameKey(raw.name)) ? '동일 호출 이름 충돌' : '50개 서버 슬롯 확보';
        removes.push({ serverId: raw._id, name: raw.name, reason, raw: clone(raw) });
        const represented = state.library.some(entry => entry.name === raw.name && entry.description === raw.description && entry.body === raw.prompt && entry.extra.isPublic === raw.isPublic && entry.source && fingerprint([entry.source]) === fingerprint([raw]));
        if (!represented) {
          const archival = LibraryCore.createEntry({ name: raw.name, description: raw.description, body: raw.prompt, isPinned: raw.isPinned, extra: { isPublic: raw.isPublic }, source: raw });
          state.library.push(archival);
          backupEntries.push(archival);
        }
      }
      const protectedSummary = originals.filter(raw => protectedIds.has(raw._id)).map(raw => ({ serverId: raw._id, name: raw.name, reason: protection(raw) || '보존할 수 없는 추가 실행 설정' }));
      const warnings = [];
      if (removes.length) warnings.push('삭제되는 비공개 원본의 전체 데이터를 먼저 로컬에 저장합니다. 실패 시 재생성해도 원래 서버 ID·고정 상태·서버 메타데이터는 그대로 복원되지 않을 수 있습니다.');
      if (creates.some(item => item.fields.isPublic)) warnings.push('공개 상태로 생성할 항목이 있습니다. 공개 여부를 미리보기에서 확인하세요.');
      warnings.push('서버 슬롯은 계정 전체가 공유합니다. 다른 채팅방과 탭에서 서로 다른 슬롯 구성을 동시에 유지할 수 없습니다.');
      return {
        format: FORMAT, schemaVersion: 1, ...ctx,
        originalRecords: originals, originalFingerprint: fingerprint(originals),
        stateSnapshot: LibraryCore.validateState(state), backupEntries,
        selectedIds: selected.activeIds.slice(), pinnedIds: selected.pinnedIds.slice(),
        reuses, creates, removes, protected: protectedSummary,
        requiresConsent: creates.length + removes.length > 0,
        requiresDeletionConsent: removes.length > 0,
        beforeCount: originals.length, afterCount: originals.length - removes.length + creates.length, warnings
      };
    }
    function explain(value) {
      const p = clone(value);
      ensure(p.format === FORMAT, '지원되지 않는 서버 적용 계획입니다.');
      return { creates: p.creates.map(({ localId, name, fields }) => ({ localId, name, isPublic: fields.isPublic })), deletes: p.removes.map(({ serverId, name, reason }) => ({ serverId, name, reason })),
        reused: p.reuses.map(({ localId, serverId, name }) => ({ localId, serverId, name })), protected: clone(p.protected),
        beforeCount: p.beforeCount, afterCount: p.afterCount, limit: LIMIT, warnings: p.warnings.slice() };
    }
    function validatePlan(value) {
      const p = clone(value);
      ensure(p.format === FORMAT && p.schemaVersion === 1, '지원되지 않는 서버 적용 계획입니다.');
      contextOf(p, p.chatId);
      checkedRecords(p.originalRecords);
      ensure(p.originalFingerprint === fingerprint(p.originalRecords), '서버 적용 미리보기 원본이 손상되었습니다.', 'PLAN_CHANGED');
      const expected = plan(p.stateSnapshot, p.chatId, p.originalRecords, p);
      for (const key of ['selectedIds', 'pinnedIds', 'reuses', 'creates', 'removes', 'protected', 'beforeCount', 'afterCount', 'requiresConsent', 'requiresDeletionConsent']) {
        ensure(stable(p[key]) === stable(expected[key]), '서버 적용 미리보기 작업이 변경되었습니다.', 'PLAN_CHANGED');
      }
      return p;
    }
    async function execute(value, adapter, options = {}) {
      const p = validatePlan(value);
      for (const method of ['current', 'readRecords', 'create', 'remove', 'saveJournal', 'saveMapping']) ensure(typeof adapter?.[method] === 'function', `서버 적용 어댑터 ${method}가 필요합니다.`, 'INVALID_ADAPTER');
      if (p.requiresConsent) ensure(options.consent === true, '서버 생성·삭제 내용을 확인한 뒤 명시적으로 동의해야 합니다.', 'CONSENT_REQUIRED');
      const ctx = contextOf(p, p.chatId);
      let expectedRecords = clone(p.originalRecords);
      let mappingStarted = false, mappingCommitted = false, journalDurable = false;
      const mappings = p.reuses.map(({ localId, serverId }) => ({ localId, serverId }));
      const journal = {
        format: 'crack-shortcut-sync-journal', schemaVersion: 1,
        id: `sync:${crypto.randomUUID()}`, accountId: p.accountId, chatId: p.chatId,
        startedAt: stamp(), updatedAt: stamp(), status: 'prepared', phase: 'prepared', operation: null,
        plan: clone(p), originalRecords: clone(p.originalRecords), stateBackup: clone(p.stateSnapshot),
        completed: [], uncertain: [], mappings: [], recovery: { status: 'not-needed', restored: [], removedCreated: [], retainedCreated: [], limitations: [] }
      };
      async function guard() {
        const current = await adapter.current();
        ensure(current && current.accountId === ctx.accountId && current.generation === ctx.generation && (current.chatId ?? null) === ctx.chatId && current.revision === ctx.revision, '계정·채팅방·저장 리비전이 변경되어 서버 적용을 중지했습니다.', 'CONTEXT_CHANGED');
      }
      async function readExpected() {
        await guard();
        const actual = checkedRecords(await adapter.readRecords());
        await guard();
        ensure(fingerprint(actual) === fingerprint(expectedRecords), '미리보기 이후 서버 원본이 변경되었습니다. 추가 서버 작업을 중지했습니다.', 'SERVER_STATE_CHANGED');
        return actual;
      }
      async function persist() {
        await guard();
        journal.updatedAt = stamp();
        const ack = await adapter.saveJournal(clone(journal));
        ensure(ack === true || ack && ack.durable === true, '전체 원본 백업과 복구 기록을 확실히 저장하지 못했습니다. 서버 작업을 중지했습니다.', 'BACKUP_NOT_DURABLE');
        if (ack && typeof ack === 'object' && own(ack, 'revision')) {
          ensure(Number.isSafeInteger(ack.revision) && ack.revision >= ctx.revision, '백업 저장 리비전 확인에 실패했습니다.', 'BACKUP_NOT_DURABLE');
          ctx.revision = ack.revision;
        }
        journalDurable = true;
        await guard();
      }
      async function observeOutcome(kind, operation, response) {
        await guard();
        const actual = checkedRecords(await adapter.readRecords());
        await guard();
        if (kind === 'remove') {
          const next = expectedRecords.filter(raw => raw._id !== operation.serverId);
          ensure(fingerprint(actual) === fingerprint(next), '삭제 결과 또는 다른 서버 변경을 확인하지 못했습니다.', 'UNVERIFIED_REMOVE');
          expectedRecords = actual;
          journal.completed.push({ type: 'remove', serverId: operation.serverId, name: operation.name, raw: clone(operation.raw), recovery: !!operation.recovery, at: stamp() });
          return null;
        }
        const priorIds = new Set(expectedRecords.map(raw => raw._id));
        const added = actual.filter(raw => !priorIds.has(raw._id));
        const unchanged = actual.filter(raw => priorIds.has(raw._id));
        const payload = response && typeof response === 'object' ? (response.data || response) : response;
        const reportedId = typeof payload === 'string' ? payload : payload?._id;
        ensure(added.length === 1 && fingerprint(unchanged) === fingerprint(expectedRecords) && equalFields(added[0], operation.fields), '새 단축어의 실제 서버 ID와 상세 본문을 확인하지 못했습니다.', 'UNVERIFIED_CREATE');
        ensure(!reportedId || typeof reportedId === 'string' && SERVER_ID.test(reportedId) && reportedId === added[0]._id, '생성 응답 ID와 실제 서버 상세 ID가 다릅니다.', 'UNVERIFIED_CREATE');
        expectedRecords = actual;
        journal.completed.push({ type: 'create', localId: operation.localId || null, serverId: added[0]._id, name: added[0].name, raw: clone(added[0]), recovery: !!operation.recovery, at: stamp() });
        return added[0];
      }
      async function mutate(kind, operation, recovering = false) {
        operation = { ...operation, recovery: recovering };
        await readExpected();
        journal.phase = recovering ? 'recovering' : 'applying';
        journal.operation = { type: kind, ...clone(operation), recovery: recovering, status: 'pending', at: stamp() };
        await persist();
        await readExpected();
        let response;
        try {
          response = kind === 'remove' ? await adapter.remove(operation.serverId) : await adapter.create(clone(operation.fields));
        } catch (error) {
          // A failed HTTP request may still have changed the server. Determine
          // its outcome before considering any recovery mutation.
          try { await observeOutcome(kind, operation, null); journal.operation.status = 'applied-with-request-error'; }
          catch {
            // A timeout, transport failure or 5xx can commit after an immediate
            // unchanged GET. Only an adapter-certified rejection proves no write.
            if (error.definitiveNoWrite === true) {
              try { await readExpected(); journal.operation.status = 'not-applied'; }
              catch { journal.uncertain.push(clone(journal.operation)); journal.operation.status = 'unknown'; }
            } else { journal.uncertain.push(clone(journal.operation)); journal.operation.status = 'unknown'; }
          }
          throw error;
        }
        let result;
        try { result = await observeOutcome(kind, operation, response); }
        catch (error) {
          journal.uncertain.push(clone(journal.operation)); journal.operation.status = 'unknown';
          throw error;
        }
        journal.operation.status = 'verified';
        await persist();
        return result;
      }
      async function recover() {
        const deleted = journal.completed.filter(item => item.type === 'remove' && !item.recovery);
        if (!deleted.length) {
          const created = journal.completed.filter(item => item.type === 'create' && !item.recovery);
          journal.recovery.status = created.length ? 'originals-intact-created-retained' : 'not-needed';
          journal.recovery.retainedCreated = created.map(item => ({ serverId: item.serverId, name: item.name, isPublic: item.raw.isPublic }));
          if (created.length) journal.recovery.limitations.push('기존 원본을 삭제하지 않았습니다. 검증된 일부 신규 항목은 서버에 유지됩니다. 다음 적용 전 복구 기록과 현재 서버 목록을 확인하세요.');
          return;
        }
        journal.recovery.status = 'incomplete';
        journal.recovery.limitations.push('원래 서버 ID·고정 상태·서버 메타데이터의 동일 복원은 보장되지 않습니다. 전체 원본은 복구 기록에 보존됩니다.');
        if (mappingStarted || journal.uncertain.length || !journalDurable) {
          journal.recovery.reason = mappingStarted ? '로컬 매핑 저장 결과를 먼저 확인해야 합니다.' : '서버 요청 결과 또는 백업 저장 결과가 불확실하여 추가 변경을 중지했습니다.';
          return;
        }
        try { await readExpected(); }
        catch (error) { journal.recovery.reason = error.message; return; }
        try {
          // Remove only private creations verified as this operation's additions.
          // A public creation is retained even if applying another item failed.
          for (const created of journal.completed.filter(item => item.type === 'create' && !item.recovery)) {
            if (created.raw.isPublic || protection(created.raw)) { journal.recovery.retainedCreated.push({ serverId: created.serverId, name: created.name }); continue; }
            await mutate('remove', { serverId: created.serverId, name: created.name, raw: created.raw }, true);
            journal.recovery.removedCreated.push({ serverId: created.serverId, name: created.name });
          }
          for (const removed of deleted) {
            ensure(expectedRecords.length < LIMIT && !expectedRecords.some(raw => LibraryCore.nameKey(raw.name) === LibraryCore.nameKey(removed.name)), '복구할 원본의 서버 슬롯 또는 호출 이름을 확보하지 못했습니다.', 'RECOVERY_CONFLICT');
            const restored = await mutate('create', { name: removed.name, fields: fieldsOf(removed.raw), recovery: true }, true);
            journal.recovery.restored.push({ originalServerId: removed.serverId, serverId: restored._id, name: removed.name, raw: clone(restored) });
          }
          journal.recovery.status = 'content-restored-with-new-ids';
        } catch (error) { journal.recovery.reason = error.message || '일부 원본의 복구가 완료되지 않았습니다.'; }
      }
      try {
        await readExpected();
        await persist(); // Full raw original backup is durable before any mutation.
        for (const removal of p.removes) await mutate('remove', removal);
        for (const creation of p.creates) {
          const raw = await mutate('create', creation);
          mappings.push({ localId: creation.localId, serverId: raw._id });
        }
        const finalRecords = await readExpected();
        ensure(mappings.length === p.selectedIds.length && new Set(mappings.map(item => item.localId)).size === mappings.length && new Set(mappings.map(item => item.serverId)).size === mappings.length, '모든 선택 단축어의 실제 서버 매핑을 확인하지 못했습니다.', 'INCOMPLETE_MAPPING');
        for (const mapping of mappings) {
          const desired = [...p.reuses, ...p.creates].find(item => item.localId === mapping.localId);
          ensure(finalRecords.some(raw => raw._id === mapping.serverId && equalFields(raw, desired.fields)), '최종 서버 단축어 상세 검증에 실패했습니다.', 'UNVERIFIED_MAPPING');
        }
        journal.status = 'mapping-pending'; journal.phase = 'mapping-pending'; journal.mappings = clone(mappings); journal.operation = null;
        await persist();
        await readExpected();
        mappingStarted = true;
        const ack = await adapter.saveMapping({ accountId: p.accountId, chatId: p.chatId, expectedRevision: ctx.revision, mappings: clone(mappings), journalId: journal.id, stateSnapshot: clone(p.stateSnapshot), records: clone(finalRecords) });
        ensure(ack === true || ack && ack.committed === true, '최종 로컬 매핑의 저장 성공을 확인하지 못했습니다.', 'MAPPING_NOT_COMMITTED');
        mappingCommitted = true;
        if (ack?.state && Number.isSafeInteger(ack.state.revision)) ctx.revision = ack.state.revision;
        journal.status = 'complete'; journal.phase = 'completed'; journal.finishedAt = stamp();
        let journalFinalized = true;
        try { await persist(); } catch { journalFinalized = false; }
        return { status: 'complete', mappings: clone(mappings), records: clone(finalRecords), state: ack?.state || null, journal: clone(journal), journalFinalized,
          warnings: journalFinalized ? p.warnings.slice() : [...p.warnings, '서버 매핑은 저장했지만 완료 복구 기록의 최종 저장을 확인하지 못했습니다. 다음 적용 전 기록을 확인하세요.'] };
      } catch (error) {
        journal.status = mappingStarted && !mappingCommitted ? 'mapping-uncertain' : journal.uncertain.length ? 'uncertain' : 'partial-failure';
        journal.failure = { code: typeof error.code === 'string' ? error.code : 'SYNC_FAILED', message: String(error.message || '서버 적용 실패'), at: stamp() };
        if (!mappingCommitted) await recover();
        journal.phase = journal.recovery.status === 'content-restored-with-new-ids' ? 'recovered'
          : !journal.completed.length && !journal.uncertain.length && !mappingStarted ? 'cancelled' : 'failed';
        try { await persist(); } catch { journal.persistenceUnconfirmed = true; }
        const failure = new Error(journal.failure.message);
        failure.code = journal.failure.code;
        failure.journal = clone(journal); failure.recovery = clone(journal.recovery); failure.mappingCommitted = mappingCommitted;
        throw failure;
      }
    }
    return { FORMAT, LIMIT, plan, explain, validatePlan, execute, fingerprint };
  })();

  // Contracts were read from Crack's public build main-arm64-9d52075.
  // Sending a shortcut serialises (shortcut:<server ID>:<label>) through Socket.IO.
  // No verified local-body execution path exists; this release never fabricates IDs.
  const libraryRuntime = (() => {
    const nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
    const subscribers = new Set();
    let accountId = null, tokenAtVerification = null, repo = null, state = null;
    let chatId = null, route = window.location.pathname, generation = 0;
    let status = '로그인 계정 확인 중 · 로컬 실행 및 서버 슬롯 동기화 미검증';
    let identityPending = null, lastIdentityCheck = 0, lastAttemptToken = '';
    let livePersonal = new Map(), lastFullRecords = null;
    let channel = null;
    let lastNativeChat = null, lastNativeMe = null;
    let nativeSyncNeeded = true, nativeSyncVersion = 0, nativeSyncPending = null;
    let nativeApplication = { phase: 'waiting', message: '네이티브 단축어 목록 확인 전' };
    let syncBusy = false, lastPresence = 0;
    let privatePurgePending = Promise.resolve();
    const tabId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    const peerTabs = new Map();
    const clone = value => JSON.parse(JSON.stringify(value));

    function queueNativeSync() {
      nativeSyncNeeded = true; nativeSyncVersion += 1;
      nativeApplication = {phase:'waiting',message:'저장한 네이티브 목록 적용 대기 중'};
    }
    function announcePresence(hello = false) {
      if (!channel || !authorised()) return;
      lastPresence = Date.now();
      try { channel.postMessage({type:'presence',tabId,chatId,hello,expires:Date.now()+60000}); } catch { /* Server writes require the account lock as well. */ }
    }
    function activePeers() {
      for (const [id,peer] of peerTabs) if (peer.expires < Date.now()) peerTabs.delete(id);
      return [...peerTabs.values()].filter(peer => peer.chatId && peer.chatId !== chatId);
    }

    function cookie(name) {
      try {
        const part = document.cookie.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
        return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
      } catch { return ''; }
    }
    function emit() {
      orderVersion += 1;
      for (const listener of subscribers) { try { listener(current()); } catch { /* Isolated UI. */ } }
    }
    function safeID(id) { return typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id); }
    function routeChat(path) {
      const match = /^\/(?:characters\/[^/]+\/chats|stories\/[^/]+\/episodes)\/([a-f0-9]{24})\/?$/i.exec(path);
      return match ? match[1] : null;
    }
    function routeChanged() {
      const path = window.location.pathname;
      if (path === route) return;
      route = path; chatId = routeChat(path); generation += 1;
      livePersonal.clear(); lastNativeChat = null; queueNativeSync(); emit();
    }
    function authorised() {
      // A token refresh also suspends presets until the identity is rechecked.
      return !!accountId && !!repo && !!state && !!tokenAtVerification && cookie('access_token') === tokenAtVerification;
    }
    function accepts(meta) {
      routeChanged();
      return authorised() && !!meta && meta.accountId === accountId && meta.token === cookie('access_token') &&
        (meta.target !== 'chat' || (meta.generation === generation && meta.chatId === chatId));
    }
    function current() {
      routeChanged();
      return { accountId: authorised() ? accountId : null, chatId, status, generation, revision: state?.revision ?? null,
        executionMode: state?.settings.executionMode || 'unverified', nativeApplication: { ...nativeApplication } };
    }
    function context() {
      routeChanged();
      return {accountId, token: cookie('access_token'), generation, route, chatId};
    }
    function sameContext(ctx, checkRoute = true) {
      routeChanged();
      return ctx.accountId === accountId && ctx.token === cookie('access_token') &&
        (!checkRoute || ctx.generation === generation);
    }
    function dropIdentity(message) {
      privatePurgePending = LibraryNativeCache.purgePrivate().catch(()=>({available:false,reason:'native-private-cache-clear-failed'}));
      repo?.close(); repo = null; state = null; accountId = null; tokenAtVerification = null;
      channel?.close(); channel = null; lastFullRecords = null; livePersonal.clear();
      peerTabs.clear();
      lastNativeChat = null; lastNativeMe = null; queueNativeSync();
      nativeApplication = { phase: 'waiting', message: '계정 확인 후 네이티브 목록 적용' };
      latestMeSnapshot = null; latestMeSequence = -1;
      applySettings(defaults()); status = message; emit();
    }
    async function request(path, ctx) {
      if (!nativeFetch || !ctx.token || !sameContext(ctx, false)) throw new Error('로그인 상태가 변경되었습니다.');
      if (!/^\/crack-api\/profiles$|^\/crack-gen\/shortcut-commands\/me(?:\/[a-f0-9]{24})?$/i.test(path)) {
        throw new Error('검증되지 않은 API 요청을 차단했습니다.');
      }
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 20000);
      try {
        const headers = {Accept: 'application/json', Authorization: 'Bearer ' + ctx.token,
          'Content-Type': 'application/json', platform: 'web', 'wrtn-locale': 'ko-KR'};
        const wrtnId = cookie('__w_id');
        if (wrtnId) headers['x-wrtn-id'] = wrtnId;
        const response = await nativeFetch(API_ORIGIN + path, {
          method: 'GET', credentials: 'include', headers, signal: controller.signal, cache: 'no-store', redirect: 'error'
        });
        if (!sameContext(ctx, false)) throw new Error('로그인 상태가 변경되었습니다.');
        if (!response.ok) throw new Error('서버 조회 실패 (HTTP ' + response.status + ')');
        const body = await response.json();
        if (!sameContext(ctx, false)) throw new Error('로그인 상태가 변경되었습니다.');
        return body;
      } finally { window.clearTimeout(timeout); }
    }
    async function refreshIdentity(force = false) {
      routeChanged();
      const token = cookie('access_token');
      // Hide old-account data even while an identity query or apply is pending.
      if (token !== tokenAtVerification && (accountId || repo || state || tokenAtVerification)) dropIdentity('로그인 계정 재확인 중 · 이전 계정 화면 비우기');
      if (syncBusy) return;
      if (identityPending) return identityPending;
      if (!token) { if (accountId || !lastIdentityCheck) dropIdentity('Crack 로그인 후 계정을 확인할 수 있습니다.'); lastIdentityCheck = Date.now(); return; }
      if (!force && token === lastAttemptToken && Date.now() - lastIdentityCheck < 60000) return;
      lastAttemptToken = token;
      if (token !== tokenAtVerification) dropIdentity('로그인 계정 재확인 중 · 저장된 프리셋 적용 일시 중지');
      identityPending = (async () => {
        await privatePurgePending;
        const ctx = context();
        try {
          const body = await request('/crack-api/profiles', ctx);
          const id = body?.data?.userId;
          if (!isID(id) || id.length > 256) throw new Error('서버 계정 식별자 형식이 변경되었습니다.');
          const candidateRepo = accountId === id && repo ? repo : await LibraryCore.open(id);
          let loaded;
          try { loaded = await candidateRepo.load(); }
          catch (error) { if (candidateRepo !== repo) candidateRepo.close(); throw error; }
          if (!sameContext(ctx, false)) { if (candidateRepo !== repo) candidateRepo.close(); return; }
          if (candidateRepo !== repo) repo?.close();
          const needsNativeSync = accountId !== id || tokenAtVerification !== ctx.token || state?.revision !== loaded.revision;
          repo = candidateRepo; accountId = id; state = loaded; tokenAtVerification = ctx.token; lastAttemptToken = ctx.token;
          applySettings(validateSettings(loaded.settings.legacy) || defaults());
          status = '로컬 저장 사용 가능 · 신규·수정 항목은 네이티브 적용에서 서버 연결';
          if (!channel && typeof BroadcastChannel === 'function') {
            channel = new BroadcastChannel('crack-shortcut-library-v2:' + id);
            channel.onmessage = event => {
              const message = event?.data;
              if (message?.type === 'presence') {
                if (message.tabId !== tabId && typeof message.tabId === 'string' && typeof message.expires === 'number') {
                  if (message.closed) peerTabs.delete(message.tabId);
                  else peerTabs.set(message.tabId,{chatId:message.chatId,expires:Math.min(message.expires,Date.now()+60000)});
                  if (message.hello) announcePresence();
                }
                return;
              }
              void reloadState().catch(() => { status = '다른 탭 변경을 읽지 못했습니다. 저장 전 다시 열어 주세요.'; emit(); });
            };
            announcePresence(true);
          }
          if (needsNativeSync) queueNativeSync();
          emit();
          await refreshNativeLists();
        } catch (error) {
          dropIdentity(error.name === 'AbortError' ? '계정 조회 시간 초과 · 프리셋 적용 중지' : String(error.message || '계정/저장소 확인 실패'));
        } finally { lastIdentityCheck = Date.now(); }
      })().finally(() => { identityPending = null; });
      return identityPending;
    }
    async function reloadState() {
      if (!authorised()) return;
      const savedRepo = repo, ctx = context();
      const loaded = await savedRepo.load();
      if (!sameContext(ctx, false) || savedRepo !== repo) return;
      if (state?.revision !== loaded.revision) queueNativeSync();
      state = loaded; applySettings(validateSettings(loaded.settings.legacy) || defaults()); emit();
      if (nativeSyncNeeded) await refreshNativeLists();
    }
    async function openState() {
      await refreshIdentity(true);
      if (!authorised()) throw new Error(status);
      const ctx=context(), openedRepo=repo;
      await reloadState();
      if (!authorised() || !sameContext(ctx) || repo!==openedRepo) throw new Error('계정 또는 채팅방이 변경되었습니다. 관리 창을 다시 열어 주세요.');
      return { ...current(), state: clone(state) };
    }
    async function save(next, expectedRevision) {
      if (syncBusy) throw new Error('서버 적용이 진행 중입니다. 완료 후 저장해 주세요.');
      if (!authorised()) throw new Error('계정을 확인하지 못했습니다. Crack 로그인 상태를 확인해 주세요.');
      const ctx = context(), savedRepo = repo;
      LibraryCore.validateState(next);
      if (!sameContext(ctx) || !authorised()) throw new Error('채팅방 또는 계정이 변경되었습니다.');
      const committed = await savedRepo.save(next, expectedRevision);
      if (!sameContext(ctx, false) || savedRepo !== repo) throw new Error('이전 계정 저장 완료 후 계정이 변경되었습니다. 현재 계정에는 적용하지 않았습니다.');
      state = committed; applySettings(validateSettings(state.settings.legacy) || defaults());
      try { channel?.postMessage({type:'state',revision: committed.revision}); } catch { /* CAS still protects writes. */ }
      queueNativeSync(); emit();
      await refreshNativeLists();
      return clone(committed);
    }
    async function fullServerRecords() {
      if (!authorised()) throw new Error('계정 확인 후 가져올 수 있습니다.');
      const ctx = context();
      const body = await request(ME_PATH, ctx);
      if (!isRecord(body?.data) || !validPersonalArray(body.data.items) || body.data.items.some(v => !safeID(v._id))) {
        throw new Error('서버 목록 구조 변경: 원본 응답을 유지했습니다.');
      }
      if (body.data.hasNext === true || body.data.hasMore === true || body.data.nextCursor) throw new Error('전체 목록 조회 여부를 확인하지 못했습니다. 가져오기를 중지했습니다.');
      const records = [];
      // Read every prompt through the observed detail API; list-only backups are incomplete.
      for (let offset = 0; offset < body.data.items.length; offset += 4) {
        const batch = await Promise.all(body.data.items.slice(offset, offset + 4).map(async item => {
          const detail = await request(ME_PATH + '/' + item._id, ctx);
          const value = detail?.data;
          if (!isRecord(value) || (value._id !== undefined && value._id !== item._id) ||
              typeof value.prompt !== 'string' || typeof (value.name ?? item.name) !== 'string' ||
              typeof (value.description ?? item.description) !== 'string' || typeof value.isPublic !== 'boolean') {
            throw new Error('단축어 상세 데이터가 불완전합니다. 가져오기를 중지했습니다.');
          }
          return { ...item, ...value, _id: item._id, isPinned: item.isPinned };
        }));
        records.push(...batch);
      }
      if (!sameContext(ctx)) throw new Error('조회 중 채팅방/계정이 변경되었습니다. 다시 가져와 주세요.');
      lastFullRecords = records;
      captureLatestMeSnapshot(body, ++requestSequence);
      return records;
    }
    async function importServer(draft) {
      const records = await fullServerRecords();
      let candidate = LibraryCore.importServer(clone(draft || state), records, {bodyKey: 'prompt',extraKeys:['isPublic']});
      // v1 remains intact; migrate only IDs actually owned by this account.
      if (!candidate.sync.migratedV1) {
        let legacy;
        try { legacy = validateSettings(JSON.parse(window.localStorage.getItem(STORAGE_KEY))); } catch { /* Ignore malformed v1. */ }
        if (legacy) {
          const owned = new Set(records.map(v=>v._id));
          legacy.masterOrder = legacy.masterOrder.filter(id=>owned.has(id));
          candidate = LibraryCore.migrate(candidate, legacy, records, {bodyKey:'prompt',extraKeys:['isPublic']});
        }
        candidate.sync.migratedV1 = true;
      }
      return candidate;
    }
    function checkSyncContext(expected) {
      const now = current();
      if (!authorised() || now.accountId !== expected.accountId || now.chatId !== expected.chatId ||
          now.generation !== expected.generation || now.revision !== expected.revision) {
        throw new Error('계정·채팅방·저장 내용이 변경되었습니다. 적용 미리보기를 다시 만들어 주세요.');
      }
    }
    async function prepareSync(draft, expected) {
      checkSyncContext(expected);
      if (LibraryCore.validateState(draft).revision !== state.revision || JSON.stringify(draft) !== JSON.stringify(state)) {
        throw new Error('현재 초안을 먼저 저장한 뒤 서버 적용을 준비해 주세요.');
      }
      const pending = state.sync.journals?.find(journal => !['completed','recovered','cancelled'].includes(journal.phase));
      if (pending) {
        const error = new Error('이전 서버 적용의 복구 기록이 남아 있습니다. 기록을 내보내어 확인하기 전에는 새로운 서버 변경을 진행할 수 없습니다.');
        error.journal = clone(pending); throw error;
      }
      announcePresence(true);
      const records = await fullServerRecords();
      checkSyncContext(expected);
      const plan = LibrarySync.plan(draft,chatId,records,{accountId,revision:state.revision,generation});
      if (plan.removes.length && activePeers().length) throw new Error('다른 채팅방의 Crack 탭이 열려 있어 서버 슬롯 교체를 차단했습니다. 해당 탭을 닫고 다시 준비해 주세요.');
      const backup = {format:'crack-shortcut-sync-backup',schemaVersion:1,accountId,createdAt:new Date().toISOString(),
        library:LibraryCore.exportBackup(state,null,accountId),serverRecords:clone(records)};
      return {plan,backup,summary:LibrarySync.explain(plan)};
    }
    async function checkRecovery(journalId) {
      if (!authorised() || syncBusy) throw new Error('로그인 또는 진행 중인 서버 적용 상태를 확인해 주세요.');
      const ctx = context(), savedRepo = repo;
      const journal = state.sync.journals?.find(item=>item.id===journalId);
      if (!journal || journal.accountId!==accountId) throw new Error('현재 계정의 복구 기록을 찾지 못했습니다.');
      const revision = state.revision, records = await fullServerRecords();
      if (!sameContext(ctx) || revision!==state.revision) throw new Error('확인 중 계정·채팅방·저장 내용이 변경되었습니다.');
      const matches = (raw,desired) => raw.name===desired.name && raw.description===desired.description && raw.prompt===desired.prompt && raw.isPublic===desired.isPublic;
      const operations = [...journal.plan.reuses,...journal.plan.creates];
      const mapped = Array.isArray(journal.mappings) && journal.mappings.length===journal.plan.selectedIds.length && journal.mappings.every(mapping=>{
        const desired = operations.find(item=>item.localId===mapping.localId);
        const server = records.find(item=>item._id===mapping.serverId);
        const entry = state.library.find(item=>item.id===mapping.localId);
        return desired && server && entry && !entry.dirty && entry.serverId===mapping.serverId && matches(server,desired.fields) && entry.body===server.prompt && entry.name===server.name;
      });
      const restoredIds = new Set();
      const missing = journal.originalRecords.filter(original=>{
        const restored = records.find(raw=>!restoredIds.has(raw._id)&&matches(raw,original));
        if (restored) restoredIds.add(restored._id);
        return !restored;
      });
      const originalIds = new Set(journal.originalRecords.map(raw=>raw._id));
      const unresolved = (journal.uncertain || []).filter(operation=>{
        if (operation.type==='create') {
          const additions = records.filter(raw=>!originalIds.has(raw._id)&&operation.fields&&matches(raw,operation.fields));
          return additions.length!==1;
        }
        return operation.type!=='remove' || records.some(raw=>raw._id===operation.serverId);
      });
      if (!mapped && unresolved.length) return {state:clone(state),resolved:false,journal:clone(journal),
        message:'이전 서버 요청의 완료 여부가 아직 불명확합니다. 추가 서버 변경을 차단했습니다. 복구 기록과 서버 상태를 보관하여 확인한 뒤 다시 검사해 주세요.'};
      if (!mapped && missing.length) return {state:clone(state),resolved:false,journal:clone(journal),
        message:`복구가 필요한 원본 ${missing.length}개: ${missing.map(raw=>'/'+raw.name).join(', ')}. 내려받은 백업의 본문·공개 상태를 확인해 Crack의 내 단축어에서 복원한 뒤 다시 확인해 주세요.`};
      const candidate = clone(state);
      const updated = candidate.sync.journals.find(item=>item.id===journalId);
      updated.phase = mapped?'completed':'recovered';
      updated.status = mapped?'complete':'content-restored-with-new-ids';
      updated.recoveryVerifiedAt=new Date().toISOString();
      updated.latestVerifiedRecords=clone(records);
      if (!mapped) {
        for (const entry of candidate.library) {
          const original = journal.originalRecords.find(raw=>raw._id===entry.serverId);
          const server = original && records.find(raw=>matches(raw,original));
          if (server && entry.name===server.name && entry.description===server.description && entry.body===server.prompt) {
            for (const other of candidate.library) if (other.id!==entry.id && other.serverId===server._id) other.serverId=null;
            entry.serverId=server._id;entry.source=clone(server);
          }
        }
      }
      const committed = await savedRepo.save(candidate,revision);
      if (!sameContext(ctx,false) || savedRepo!==repo) throw new Error('기록은 이전 계정에만 저장했습니다. 현재 계정에는 적용하지 않았습니다.');
      state=committed;queueNativeSync();emit();
      try { channel?.postMessage({type:'state',revision:state.revision}); } catch { /* CAS remains authoritative. */ }
      await refreshNativeLists();
      return {state:clone(state),resolved:true,journal:clone(updated),message:mapped?'실제 서버 ID와 저장된 연결을 확인했습니다. 완료 기록을 복구했습니다.':'원본 본문·이름·공개 상태의 복원을 확인했습니다. 서버 ID·고정 상태·메타데이터는 이전과 다를 수 있습니다.'};
    }
    async function syncRequest(method, id, fields, ctx) {
      if (!authorised() || !sameContext(ctx)) throw new Error('서버 변경 전에 계정 또는 채팅방이 변경되었습니다.');
      if (activePeers().length) {
        const error=new Error('다른 채팅방 탭이 열려 있어 추가 서버 변경을 중지했습니다.');
        error.definitiveNoWrite=true;throw error;
      }
      const path = method === 'POST' && id === null ? '/crack-gen/shortcut-commands' :
        method === 'DELETE' && safeID(id) ? '/crack-gen/shortcut-commands/'+id : null;
      if (!path || !nativeFetch) throw new Error('검증되지 않은 서버 변경 요청을 차단했습니다.');
      const controller = new AbortController(), timer = window.setTimeout(()=>controller.abort(),20000);
      try {
        const headers = {Accept:'application/json',Authorization:'Bearer '+ctx.token,'Content-Type':'application/json',platform:'web','wrtn-locale':'ko-KR'};
        const wrtnId = cookie('__w_id'); if (wrtnId) headers['x-wrtn-id'] = wrtnId;
        const response = await nativeFetch(API_ORIGIN+path,{method,credentials:'include',headers,signal:controller.signal,redirect:'error',
          ...(method==='POST'?{body:JSON.stringify(fields)}:{})});
        if (!response.ok) {
          const error = new Error('서버 변경 실패 (HTTP '+response.status+'). 복구 기록을 확인해 주세요.');
          error.httpStatus=response.status;
          error.definitiveNoWrite=response.status>=400 && response.status<500 && response.status!==408;
          throw error;
        }
        if (!sameContext(ctx)) throw new Error('서버 요청 후 계정 또는 채팅방이 변경되었습니다. 복구 기록을 확인해 주세요.');
        return method==='POST' ? await response.json() : null;
      } finally { window.clearTimeout(timer); }
    }
    async function applySync(plan, options = {}) {
      if (options.consent !== true) throw new Error('변경 미리보기의 서버 적용 동의가 필요합니다.');
      checkSyncContext(plan);
      if (syncBusy) throw new Error('이 탭에서 다른 서버 적용이 진행 중입니다.');
      if (typeof navigator === 'undefined' || !navigator.locks?.request) throw new Error('이 브라우저에는 계정별 동시 적용 잠금이 없어 서버 변경을 차단했습니다.');
      return navigator.locks.request('crack-shortcut-library-sync:'+accountId,{mode:'exclusive',ifAvailable:true},async lock => {
        if (!lock) throw new Error('다른 Crack 탭에서 서버 적용 중입니다. 완료 후 다시 준비해 주세요.');
        checkSyncContext(plan);
        if (plan.removes.length && activePeers().length) throw new Error('다른 채팅방 탭이 열려 있어 서버 슬롯 교체를 차단했습니다.');
        const ctx = context(), savedRepo = repo;
        const persisted = await savedRepo.load();
        if (persisted.revision !== state.revision) throw new Error('다른 탭에서 설정이 바뀌었습니다. 미리보기를 다시 만들어 주세요.');
        syncBusy = true;
        async function commitSync(candidate) {
          if (!sameContext(ctx) || savedRepo !== repo || !authorised()) throw new Error('적용 중 계정 또는 채팅방이 변경되었습니다.');
          const committed = await savedRepo.save(candidate,state.revision);
          if (!sameContext(ctx,false) || savedRepo !== repo) throw new Error('이전 계정의 기록만 저장했습니다. 현재 계정에는 적용하지 않았습니다.');
          state = committed;
          applySettings(validateSettings(state.settings.legacy)||defaults());
          try { channel?.postMessage({type:'state',revision:state.revision}); } catch { /* CAS remains authoritative. */ }
          emit();
          return committed;
        }
        try {
          const result = await LibrarySync.execute(plan,{
            current,
            readRecords:fullServerRecords,
            create:async fields => (await syncRequest('POST',null,fields,ctx))?.data,
            remove:async id => { await syncRequest('DELETE',id,null,ctx); },
            saveJournal:async journal => {
              let candidate = clone(state);
              if (!candidate.sync.journals?.some(item=>item.id===journal.id)) {
                for (const archived of plan.backupEntries || []) if (!candidate.library.some(entry=>entry.id===archived.id)) candidate.library.push(clone(archived));
                // Backups must not refresh the user's frozen desired entries or
                // initialize defaults. Archive missing raw originals separately.
                for (const raw of plan.originalRecords) {
                  const represented = candidate.library.some(entry=>entry.name===raw.name&&entry.description===raw.description&&entry.body===raw.prompt&&entry.extra.isPublic===raw.isPublic&&entry.source&&LibrarySync.fingerprint([entry.source])===LibrarySync.fingerprint([raw]));
                  if (!represented) candidate.library.push(LibraryCore.createEntry({name:raw.name,description:raw.description,body:raw.prompt,isPinned:raw.isPinned,extra:{isPublic:raw.isPublic},source:raw}));
                }
                candidate.sync.latestServerRecords=clone(plan.originalRecords);
              }
              const journals = Array.isArray(candidate.sync.journals) ? candidate.sync.journals : [];
              const index = journals.findIndex(item=>item.id===journal.id);
              if (index<0) journals.push(clone(journal)); else journals[index] = clone(journal);
              candidate.sync.journals = journals;
              const committed = await commitSync(candidate);
              const verified = await savedRepo.load();
              const stored = verified.sync.journals.find(item=>item.id===journal.id);
              if (verified.revision !== committed.revision || JSON.stringify(stored)!==JSON.stringify(journal)) throw new Error('복구 기록의 영구 저장을 확인하지 못했습니다.');
              return {durable:true,revision:committed.revision};
            },
            saveMapping:async payload => {
              if (payload.expectedRevision !== state.revision || payload.accountId !== accountId || payload.chatId !== chatId) throw new Error('실행 ID 저장 전 설정이 변경되었습니다. 복구 기록을 확인해 주세요.');
              let candidate = clone(state);
              const records = payload.records || await fullServerRecords();
              for (const mapping of payload.mappings) {
                const entry = candidate.library.find(item=>item.id===mapping.localId);
                const server = records.find(item=>item._id===mapping.serverId);
                if (!entry || !server || !safeID(server._id) || entry.name!==server.name || entry.description!==server.description || entry.body!==server.prompt || entry.extra.isPublic!==server.isPublic) throw new Error('서버 등록 내용을 확인하지 못해 실행 ID 연결을 중지했습니다.');
                for (const other of candidate.library) if (other.id!==entry.id && other.serverId===server._id) other.serverId=null;
                entry.serverId=server._id;entry.source=clone(server);entry.dirty=false;entry.updatedAt=new Date().toISOString();
              }
              const existingIds = new Set(records.map(item=>item._id));
              for (const entry of candidate.library) if (entry.serverId && !existingIds.has(entry.serverId)) entry.serverId=null;
              candidate.settings.executionMode='server-slots-manual';
              candidate.sync.latestServerRecords=clone(records);
              candidate.sync.manualSyncChat=chatId;
              const committed = await commitSync(LibraryCore.validateState(candidate));
              return {committed:true,state:clone(committed)};
            }
          },{consent:true});
          queueNativeSync();
          await refreshNativeLists();
          return {state:clone(state),application:{...nativeApplication},journal:result.journal};
        } catch (error) {
          if (sameContext(ctx,false) && savedRepo===repo) error.localState=clone(state);
          throw error;
        } finally { syncBusy=false; }
      });
    }
    function observe(body, meta) {
      routeChanged();
      if (!authorised() || meta?.generation !== generation || meta?.accountId !== accountId || meta?.token !== cookie('access_token')) return;
      if (meta.target === 'me' && validPersonalArray(body?.data?.items)) { lastNativeMe = clone(body); return; }
      if (meta.target !== 'chat' || !chatId || meta.chatId !== chatId || !validPersonalArray(body?.data?.personal)) return;
      lastNativeChat = clone(body);
      livePersonal = new Map(body.data.personal.map(v => [v._id, clone(v)])); emit();
    }
    function captureRequest(target, input) {
      const ctx = context();
      let requestedChat = null;
      if (target === 'chat') {
        try { requestedChat = new URL(input, document.baseURI).pathname.split('/').pop(); } catch { /* No target. */ }
      }
      return {...ctx, target, chatId: requestedChat};
    }
    function originalMatches(entry, server) {
      if (!authorised() || !server || entry.dirty || server.adminBlockedAt!=null || entry.source?.adminBlockedAt!=null) return false;
      return entry.name === server.name && entry.description === server.description &&
        typeof entry.source?.prompt === 'string' && entry.body === entry.source.prompt &&
        (typeof server.prompt !== 'string' || server.prompt === entry.body);
    }
    function executable(entry) {
      return originalMatches(entry, entry?.serverId ? livePersonal.get(entry.serverId) : null);
    }
    function executionStatus(entry) {
      if (!authorised()) return '계정 확인 필요';
      if (executable(entry)) return '서버 원본 호출 경로 · 실전 실행 결과 미검증';
      if (entry?.serverId && entry.dirty) return '로컬 수정본 · 네이티브 적용 필요';
      return '로컬 보관 · 네이티브 적용 필요';
    }
    function transformChat(body, meta) {
      routeChanged();
      if (!authorised() || meta?.generation !== generation || meta?.accountId !== accountId || meta?.token !== cookie('access_token') || !chatId || meta.chatId !== chatId) return body;
      // Only an explicit saved chat preset is applied. Unregistered/edited local
      // entries never enter Crack's native response because the server needs an ID.
      const profile = state.profiles.find(v => v.chatId === chatId);
      const resolved = LibraryCore.profile(state,chatId);
      const ids = resolved.activeIds;
      const pinned = new Set(resolved.pinnedIds || []);
      if (!profile && !state.sync.defaultConfigured) return body;
      if (!isRecord(body?.data) || !validPersonalArray(body.data.personal)) return body;
      const data = body.data, oldIds = new Set(data.personal.map(v => v._id));
      if (Object.hasOwn(data, 'total') && (!Array.isArray(data.total) || data.total.some(v=>!isRecord(v)||!isID(v._id)) || new Set(data.total.map(v=>v._id)).size !== data.total.length)) return body;
      const entries = new Map(state.library.map(v => [v.id, v]));
      const selected = new Map(ids.map(id => entries.get(id)).filter(v => v && executable(v)).map((v, i) => [v.serverId, {entry:v,rank:i}]));
      const personal = data.personal.filter(v => selected.has(v._id)).map(v => ({...v, isPinned:pinned.has(selected.get(v._id).entry.id)}));
      const rankMap = new Map([...selected].map(([id,v])=>[id,v.rank]));
      const ranked = rankItems(personal, rankMap).sort((a,b) => Number(b.isPinned) - Number(a.isPinned));
      const byId = new Map(ranked.map(v=>[v._id,v]));
      const next = {...data, personal:ranked};
      if (Array.isArray(data.total)) {
        const total = data.total.filter(v => !oldIds.has(v._id) || byId.has(v._id))
          .map(v=>byId.has(v._id) ? {...v,isPinned:byId.get(v._id).isPinned} : v);
        const totalById = new Map(total.map(v => [v._id,v]));
        const orderedPersonal = ranked.filter(v => totalById.has(v._id)).map(v => ({...totalById.get(v._id),isPinned:v.isPinned}));
        let cursor = 0;
        next.total = total.map(v => byId.has(v._id) ? orderedPersonal[cursor++] : v);
      }
      return {...body, data:next};
    }
    function transformMe(body, meta) {
      if (!accepts(meta) || !state.sync.defaultConfigured || !validPersonalArray(body?.data?.items)) return body;
      const resolved = LibraryCore.profile(state,null), pins = new Set(resolved.pinnedIds);
      const entries = new Map(state.library.map(entry => [entry.id,entry]));
      const servers = new Map(body.data.items.map(item => [item._id,item]));
      const items = resolved.activeIds.map(id => entries.get(id)).filter(entry => entry && originalMatches(entry,servers.get(entry.serverId)))
        .map(entry => ({...servers.get(entry.serverId),isPinned:pins.has(entry.id)}));
      items.sort((a,b) => Number(b.isPinned) - Number(a.isPinned));
      return {...body,data:{...body.data,items}};
    }
    function sameRows(left, right) {
      return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
        left.every((item,index) => item._id === right[index]._id && item.isPinned === right[index].isPinned);
    }
    async function refreshNativeLists() {
      if (!authorised() || !nativeSyncNeeded) return { ...nativeApplication };
      if (nativeSyncPending) {
        await nativeSyncPending;
        return nativeSyncNeeded ? refreshNativeLists() : { ...nativeApplication };
      }
      const keys = LibraryNativeCache.keys(chatId);
      if (!keys.available) {
        nativeApplication = { phase:'waiting', message:'네이티브 목록 연결 대기 중. 저장한 설정은 유지됩니다.' };
        return { ...nativeApplication };
      }
      const targets = [chatId ? keys.chatKey : keys.personalKey].filter(key => key && LibraryNativeCache.has(key));
      if (!targets.length) {
        nativeApplication = { phase:'waiting', message:'단축어 패널을 열면 저장한 목록을 적용합니다.' };
        return { ...nativeApplication };
      }
      const ctx = context(), version = nativeSyncVersion;
      nativeSyncNeeded = false;
      nativeSyncPending = (async () => {
        const outcomes = [];
        for (const key of targets) {
          if (!sameContext(ctx) || !authorised()) return;
          outcomes.push({key,result:await LibraryNativeCache.revalidate(key)});
        }
        if (!sameContext(ctx) || version !== nativeSyncVersion || !authorised()) return;
        const chatResult = outcomes.find(outcome => outcome.key === keys.chatKey);
        const meResult = outcomes.find(outcome => outcome.key === keys.personalKey);
        const relevant = chatId ? chatResult : meResult;
        if (!relevant) {
          nativeSyncNeeded = true;
          nativeApplication = { phase:'waiting', message:'현재 단축어 패널을 열면 저장한 목록을 적용합니다.' };
        } else {
          const cached = relevant.result.entry?.data;
          const raw = chatId ? lastNativeChat : lastNativeMe;
          const meta = {...ctx,target:chatId?'chat':'me'};
          const expected = raw && (chatId ? transformChat(raw,meta) : transformMe(raw,meta));
          const verified = relevant.result.revalidated && !relevant.result.entry?.error && expected &&
            (chatId ? sameRows(cached?.data?.personal,expected.data.personal) &&
              (!Array.isArray(expected.data.total) || sameRows(cached?.data?.total,expected.data.total)) : sameRows(cached?.data?.items,expected.data.items));
          if (!verified) {
            nativeApplication = { phase:'failed', message:'로컬 저장 완료. 네이티브 목록 반영을 확인하지 못했습니다. 저장 후 새로고침으로 다시 적용해 주세요.' };
          } else {
            const resolved = LibraryCore.profile(state,chatId);
            const count = chatId ? expected.data.personal.length : expected.data.items.length;
            const configured = chatId ? state.profiles.some(profile => profile.chatId===chatId) || state.sync.defaultConfigured : state.sync.defaultConfigured;
            const blocked = configured ? Math.max(0,resolved.activeIds.length-count) : 0;
            nativeApplication = { phase:blocked?'partial':'applied', selected:resolved.activeIds.length, applied:count, blocked,
              message:blocked ? `로컬 저장 완료 · 네이티브 목록 ${count}개 반영. 신규·수정 항목 ${blocked}개는 “네이티브 적용”에서 서버 연결이 필요합니다.` : `네이티브 단축어 목록 ${count}개 반영 완료` };
          }
        }
        emit();
      })().catch(() => {
        if (sameContext(ctx) && version === nativeSyncVersion) {
          nativeApplication = {phase:'failed',message:'로컬 저장 완료. 네이티브 목록 조회가 실패했습니다. 저장 후 새로고침으로 다시 적용해 주세요.'};
          emit();
        }
      }).finally(() => { nativeSyncPending = null; });
      await nativeSyncPending;
      return version !== nativeSyncVersion && nativeSyncNeeded ? refreshNativeLists() : { ...nativeApplication };
    }
    function installFetchObserver() {
      if (!nativeFetch) return;
      const descriptor = Object.getOwnPropertyDescriptor(window, 'fetch');
      if (!descriptor || (!descriptor.configurable && !descriptor.writable)) return;
      const original = descriptor.value;
      try {
        Object.defineProperty(window, 'fetch', {...descriptor, value: function(...args) {
          let target = null, meta;
          try {
            let input = typeof args[0] === 'string' ? args[0] : null;
            let method = 'GET', inspectable = args[1] === undefined;
            // Invoke native branded getters, never a caller's url/toString or
            // method accessor. Request and URL inputs keep native conversion.
            if (!input && typeof Request === 'function') {
              try {
                input = Reflect.apply(Object.getOwnPropertyDescriptor(Request.prototype,'url').get,args[0],[]);
                method = Reflect.apply(Object.getOwnPropertyDescriptor(Request.prototype,'method').get,args[0],[]);
              } catch { input = null; }
            }
            if (!input) {
              try { input = Reflect.apply(Object.getOwnPropertyDescriptor(URL.prototype,'href').get,args[0],[]); }
              catch { /* An arbitrary input remains entirely native. */ }
            }
            if (isRecord(args[1]) && Object.getPrototypeOf(args[1]) === Object.prototype) {
              const ownMethod = Object.getOwnPropertyDescriptor(args[1],'method');
              inspectable = !ownMethod || Object.hasOwn(ownMethod,'value');
              if (ownMethod && inspectable) method = ownMethod.value || method;
            }
            if (input && inspectable) {
              target = identifyTargetRequest(method,input);
              if (target) meta = {...captureRequest(target,input), sequence:++requestSequence};
            }
          } catch { /* Delegate native conversion and exception behavior. */ }
          return Reflect.apply(original,this,args).then(async response => {
            if (!target || !response.ok || identifyTargetRequest('GET', response.url) !== target) return response;
            try {
              const body = await response.clone().json();
              if (meta.target === 'me' && accepts(meta)) captureLatestMeSnapshot(body,meta.sequence);
              observe(body, meta);
              const transformed = transformPayload(body,meta);
              if (body === transformed) return response;
              const headers = new Headers(response.headers);
              headers.delete('content-length'); headers.delete('content-encoding');
              const result = new Response(JSON.stringify(transformed),{status:response.status,statusText:response.statusText,headers});
              for (const key of ['url','redirected','type']) Object.defineProperty(result,key,{value:response[key]});
              return result;
            } catch { return response; }
          });
        }});
      } catch { warnOnce('fetch-observer','fetch observer unavailable; XHR remains supported'); }
    }
    function start() {
      chatId = routeChat(route);
      installFetchObserver();
      void refreshIdentity();
      window.addEventListener('popstate',routeChanged);
      window.addEventListener('pageshow',()=>{routeChanged();void refreshIdentity(true);});
      window.addEventListener('focus',()=>{void refreshIdentity(true);});
      window.addEventListener('pagehide',()=>{try{channel?.postMessage({type:'presence',tabId,chatId,closed:true,expires:Date.now()});}catch{/* No server effect. */}});
      window.setInterval(()=>{routeChanged();void refreshIdentity();if(nativeSyncNeeded&&authorised()&&!syncBusy)void refreshNativeLists();if(Date.now()-lastPresence>3000)announcePresence();},1500);
    }
    return {current,context,captureRequest,observe,transformChat,transformMe,refreshNativeLists,prepareSync,applySync,checkRecovery,authorised,accepts,openState,save,importServer,
      executionStatus,start,refreshIdentity,subscribe(listener){subscribers.add(listener);return()=>subscribers.delete(listener);}};
  })();

  // The library editor never writes to Crack. All changes remain a draft until
  // the account-scoped IndexedDB transaction succeeds.
  let libraryDialogSession = null;
  let libraryMenuControl = null;
  let libraryMenuStarted = false;
  const libraryUIStyles = `
    :host{color-scheme:light;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;--bg:#fff;--surface:#fff;--fg:#1c2638;--muted:#59677e;--placeholder:#63718a;--line:#d7deeb;--control-line:#8592a8;--soft:#f5f7fc;--hover:#eef1f9;--input-bg:#fbfcff;--accent:#5846bd;--accent-hover:#4936a5;--accent-soft:#f0ecff;--primary-fg:#fff;--danger:#ac2944;--danger-soft:#fff0f3;--success:#23664a;--warning-bg:#fff7df;--warning-line:#d4b25f;--warning-fg:#684c16;--focus:#755cd2;--disabled-bg:#edf0f6;--disabled-fg:#6f7b90;--scroll-thumb:#a0abc0;--scroll-track:#f1f3f8;--selection-bg:#ded5ff;--selection-fg:#23164d;--backdrop:#18203680;--shadow:0 18px 70px #25335433,0 2px 10px #25335414;color:var(--fg)}
    :host([data-crack-theme="dark"]){color-scheme:dark;--bg:#171c27;--surface:#1d2432;--fg:#eef2fc;--muted:#b0bcd0;--placeholder:#a2afc6;--line:#39465d;--control-line:#65758f;--soft:#202838;--hover:#2c374b;--input-bg:#151c29;--accent:#b6a3ff;--accent-hover:#c5b5ff;--accent-soft:#302947;--primary-fg:#24183f;--danger:#ffa0b3;--danger-soft:#3d2634;--success:#96ddb5;--warning-bg:#352e20;--warning-line:#826936;--warning-fg:#f0d79d;--focus:#c2afff;--disabled-bg:#242c3b;--disabled-fg:#98a6bd;--scroll-thumb:#6b7b97;--scroll-track:#171e2b;--selection-bg:#574773;--selection-fg:#f4efff;--backdrop:#070a12b3;--shadow:0 20px 80px #0009,0 2px 12px #0005}
    *{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:var(--scroll-thumb) var(--scroll-track)}*::selection{background:var(--selection-bg);color:var(--selection-fg)}*::-webkit-scrollbar{width:9px;height:9px}*::-webkit-scrollbar-track{background:var(--scroll-track);border-radius:8px}*::-webkit-scrollbar-thumb{background:var(--scroll-thumb);border:2px solid var(--scroll-track);border-radius:8px}dialog{position:fixed;inset:0;width:min(940px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:0;border:1px solid var(--line);border-radius:16px;background:var(--bg);color:var(--fg);box-shadow:var(--shadow);overflow:hidden}dialog::backdrop{background:var(--backdrop)}
    .shell{display:flex;flex-direction:column;max-height:calc(100dvh - 34px);overflow:auto}header{display:flex;align-items:flex-start;flex-shrink:0;gap:12px;padding:20px 22px 10px}h2{font-size:19px;margin:0 0 6px}h3{font-size:16px;margin:14px 0 9px}.grow{flex:1;min-width:0}.muted{color:var(--muted)}.context{font-size:12px;overflow-wrap:anywhere}.counts{font-weight:600;margin-top:6px}
    button,input,textarea,select{font:inherit;color:var(--fg)}button{padding:8px 11px;border:1px solid var(--control-line);border-radius:8px;background:var(--surface);color:var(--fg);cursor:pointer;min-height:36px;white-space:nowrap;transition:background-color .12s,color .12s,border-color .12s}button:hover:not(:disabled){background:var(--hover)}button:disabled{opacity:1;background:var(--disabled-bg);color:var(--disabled-fg);border-color:var(--line);cursor:not-allowed}.primary{background:var(--accent);color:var(--primary-fg);border-color:var(--accent);font-weight:600}.primary:hover:not(:disabled){background:var(--accent-hover);border-color:var(--accent-hover)}.danger{color:var(--danger)}.danger:hover:not(:disabled){background:var(--danger-soft);border-color:var(--danger)}.icon{padding:6px 9px}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid var(--focus);outline-offset:2px}input,textarea,select{accent-color:var(--accent);caret-color:var(--accent)}input::placeholder,textarea::placeholder{color:var(--placeholder);opacity:1}input:disabled,textarea:disabled,select:disabled{background:var(--disabled-bg);color:var(--disabled-fg)}
    .notice{margin:0 22px 12px;padding:10px 12px;border-radius:8px;background:var(--warning-bg);border:1px solid var(--warning-line);color:var(--warning-fg);font-size:12px;line-height:1.55}.status{margin:0 22px 10px;min-height:20px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}.status.error{color:var(--danger)}.status.success{color:var(--success)}.workspace{padding:0 22px;display:flex;flex-direction:column;min-height:0;flex:1}.toolbar{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px}.search{width:100%;border:1px solid var(--control-line);border-radius:8px;padding:10px 12px;background:var(--input-bg);color:var(--fg);margin-bottom:12px}.tabs{display:flex;gap:8px;padding-bottom:10px}.tabs button[aria-selected=true]{background:var(--accent-soft);color:var(--accent);border-color:var(--accent);font-weight:700}.tabs button[aria-selected=true]:hover:not(:disabled){background:var(--accent-soft)}.scroll{overflow:auto;overscroll-behavior:contain;padding:0 1px 12px;min-height:140px;max-height:45dvh}.rows{display:grid;gap:8px}.row{border:1px solid var(--line);border-radius:10px;padding:11px 12px;background:var(--surface)}.row.dragging{opacity:.55}.row.dragover{background:var(--accent-soft);border-color:var(--accent);box-shadow:0 0 0 2px var(--focus)}.row-head{display:flex;gap:12px;align-items:flex-start}.name{font-weight:700;overflow-wrap:anywhere}.description{font-size:12px;margin-top:4px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}.execution{font-size:11px;margin-top:6px;color:var(--muted)}.row-actions{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px}.row-actions button{font-size:12px;padding:5px 8px;min-height:32px}.draghandle{cursor:grab;touch-action:none;user-select:none}.empty{padding:28px 10px;text-align:center;color:var(--muted)}
    footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:14px 22px;border-top:1px solid var(--line);background:var(--soft)}.footer-note{font-size:11px;color:var(--muted);width:100%;line-height:1.5}.form-pane{padding:0 22px 20px;overflow:auto;max-height:60dvh}.field{display:block;margin:13px 0}.field>span{display:block;font-weight:600;margin-bottom:6px}.field input:not([type=checkbox]),.field textarea{width:100%;padding:9px 10px;border:1px solid var(--control-line);border-radius:8px;background:var(--input-bg);color:var(--fg)}textarea{resize:vertical}.check{display:flex;gap:8px;align-items:flex-start;margin:12px 0}.check input{margin-top:3px}.help{font-size:12px;color:var(--muted);line-height:1.55}.form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:15px}.preview{padding:12px;background:var(--soft);border:1px solid var(--line);border-radius:8px;color:var(--fg);white-space:pre-wrap;overflow-wrap:anywhere}.mode{display:flex;gap:12px;flex-wrap:wrap}.hidden{display:none!important}
    @media(prefers-reduced-motion:reduce){button{transition:none}}
    @media(max-width:600px){dialog{width:calc(100vw - 12px);max-height:calc(100dvh - 12px);border-radius:12px}.shell{max-height:calc(100dvh - 14px)}header{padding:15px 14px 9px}.workspace,.form-pane{padding-left:14px;padding-right:14px}.notice,.status{margin-left:14px;margin-right:14px}footer{padding:12px 14px;gap:6px}footer button{flex:1}.scroll{max-height:43dvh}.toolbar button{font-size:12px;padding:7px 8px}.row{padding:10px}.form-pane{max-height:58dvh}}
  `;

  function libraryUIElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function libraryUIClone(value) { return JSON.parse(JSON.stringify(value)); }
  function libraryUIFollowTheme(host) {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const roots = [document.body, document.documentElement].filter(Boolean);
    function apply() {
      let theme = null;
      // Crack's provider sets body[data-theme], including forced route themes.
      // The visible page marker takes precedence over the operating system.
      for (const root of roots) {
        for (const attribute of ['data-theme', 'data-color-mode', 'data-color-scheme']) {
          const value = root.getAttribute(attribute)?.toLowerCase();
          if (value === 'light' || value === 'dark') { theme = value; break; }
        }
        if (theme) break;
      }
      if (!theme) {
        for (const root of roots) {
          if (root.classList.contains('dark')) { theme = 'dark'; break; }
          if (root.classList.contains('light')) { theme = 'light'; break; }
        }
      }
      if (!theme) {
        for (const root of roots) {
          const scheme = getComputedStyle(root).colorScheme.trim();
          if (scheme === 'light' || scheme === 'dark') { theme = scheme; break; }
        }
      }
      theme ||= media.matches ? 'dark' : 'light';
      if (host.getAttribute('data-crack-theme') !== theme) host.setAttribute('data-crack-theme', theme);
      host.style.colorScheme = theme;
    }
    const observer = new MutationObserver(apply);
    for (const root of roots) observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-color-mode', 'data-color-scheme', 'class', 'style'] });
    if (media.addEventListener) media.addEventListener('change', apply);
    else media.addListener(apply);
    apply();
    return () => {
      observer.disconnect();
      if (media.removeEventListener) media.removeEventListener('change', apply);
      else media.removeListener(apply);
    };
  }
  function libraryUIMessage(error) {
    const message = typeof error?.message === 'string' ? error.message : '';
    if (/stale|revision|버전|동시 저장/i.test(message) || ['REVISION_CONFLICT', 'CONCURRENT_WRITE'].includes(error?.code)) return '다른 탭에서 데이터가 변경되었습니다. 현재 초안은 유지됩니다. JSON으로 내보낸 뒤 창을 다시 열어 최신 데이터를 확인하세요.';
    if (/quota|storage|indexed|저장소/i.test(message)) return '브라우저 저장소에 저장하지 못했습니다. 초안은 유지됩니다. JSON으로 내보내어 보관한 뒤 저장소 상태를 확인하세요.';
    return message || '작업을 완료하지 못했습니다. 현재 초안은 유지됩니다.';
  }
  function libraryUIStatusText(status) {
    if (typeof status === 'string') return status;
    if (status && typeof status.message === 'string') return status.message;
    return '계정 또는 채팅방 정보가 아직 확인되지 않았습니다.';
  }
  function libraryUIDownload(data, label) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = libraryUIElement('a');
    anchor.href = url;
    anchor.download = `crack-shortcuts-${label}-${new Date().toISOString().slice(0, 10)}.json`;
    document.documentElement.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function openLibraryUI(returnFocus) {
    if (libraryDialogSession) { libraryDialogSession.dialog.focus(); return; }
    const host = libraryUIElement('div');
    host.setAttribute('data-crack-library-modal', '');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = libraryUIElement('style');
    style.textContent = libraryUIStyles;
    const dialog = libraryUIElement('dialog');
    dialog.setAttribute('aria-labelledby', 'library-title');
    dialog.setAttribute('aria-describedby', 'library-execution-note');
    dialog.tabIndex = -1;
    const shell = libraryUIElement('div', 'shell');
    const header = libraryUIElement('header');
    const headContent = libraryUIElement('div', 'grow');
    const title = libraryUIElement('h2', '', '단축어 라이브러리');
    title.id = 'library-title';
    const context = libraryUIElement('div', 'context muted', '계정과 저장소 확인 중…');
    const counts = libraryUIElement('div', 'counts');
    headContent.append(title, context, counts);
    const closeButton = libraryUIElement('button', 'icon', '✕');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', '저장하지 않고 닫기');
    header.append(headContent, closeButton);
    const notice = libraryUIElement('div', 'notice', '새로 만들거나 수정한 로컬 단축어는 채팅방에서 “네이티브 적용”으로 서버 등록 계획을 확인하세요. 서버 변경은 백업 확인과 명시적 동의 후에만 진행합니다. 저장·목록 반영과 실제 채팅 실행 결과는 별도로 확인됩니다.');
    notice.id = 'library-execution-note';
    const status = libraryUIElement('div', 'status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const workspace = libraryUIElement('div', 'workspace');
    const toolbar = libraryUIElement('div', 'toolbar');
    const search = libraryUIElement('input', 'search');
    search.type = 'search';
    search.placeholder = '이름·설명·본문 검색';
    search.setAttribute('aria-label', '단축어 검색');
    const tabs = libraryUIElement('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '단축어 목록');
    const activeTab = libraryUIElement('button', '', '활성 단축어');
    const archiveTab = libraryUIElement('button', '', '보관함');
    activeTab.id = 'library-active-tab';
    archiveTab.id = 'library-archive-tab';
    for (const tab of [activeTab, archiveTab]) {
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'library-list');
    }
    tabs.append(activeTab, archiveTab);
    const scroll = libraryUIElement('div', 'scroll');
    scroll.id = 'library-list';
    scroll.setAttribute('role', 'tabpanel');
    workspace.append(toolbar, search, tabs, scroll);
    const pane = libraryUIElement('div', 'form-pane hidden');
    const footer = libraryUIElement('footer');
    const restoreButton = libraryUIElement('button', '', '기본값 복원');
    const spacer = libraryUIElement('div', 'grow');
    const cancelButton = libraryUIElement('button', '', '취소');
    const saveButton = libraryUIElement('button', 'primary', '저장');
    const reloadButton = libraryUIElement('button', '', '저장 후 새로고침');
    const footerNote = libraryUIElement('div', 'footer-note', '저장은 전체·내 단축어 목록을 갱신합니다. 신규·수정 항목은 “네이티브 적용”에서 백업·변경 동의 후 실제 서버 ID에 연결합니다. 보관은 현재 프리셋에서만 제외합니다.');
    footer.append(restoreButton, spacer, cancelButton, saveButton, reloadButton, footerNote);
    shell.append(header, notice, status, workspace, pane, footer);
    dialog.append(shell);
    shadow.append(style, dialog);
    // Dialog inputs must never bubble into Crack's composer shortcut handlers.
    for (const eventName of ['keydown', 'keyup', 'keypress', 'click', 'dblclick', 'pointerdown', 'pointerup', 'input', 'change', 'submit']) {
      host.addEventListener(eventName, event => event.stopPropagation());
    }
    document.documentElement.append(host);
    const stopTheme = libraryUIFollowTheme(host);
    let closed = false;
    let dirty = false;
    let saving = false;
    let busy = false;
    let stale = false;
    let loaded = null;
    let draft = null;
    let tabName = 'active';
    let draggedId = null;
    let pointerDrag = null;
    let unsubscribe = () => {};
    let paneKind = null;
    let profileTouched = false;
    let privacyBlocked = false;
    let privacyClosePending = false;
    const privacyDisplays = new Map();
    const privacyControls = new Map();
    const mutationButtons = new Set([restoreButton, saveButton, reloadButton]);
    libraryDialogSession = { dialog, host };

    function say(message, kind = '') {
      if (closed) return;
      if (loaded) updatePrivacy(libraryRuntime.current());
      if (closed || privacyBlocked || privacyClosePending) return;
      status.className = `status ${kind}`;
      status.textContent = message;
    }
    function close() {
      if (closed || saving) return;
      closed = true;
      unsubscribe();
      stopTheme();
      try { dialog.close(); } catch { /* Removing the host still closes it. */ }
      host.remove();
      libraryDialogSession = null;
      const target = returnFocus?.isConnected ? returnFocus : libraryMenuControl;
      if (target?.isConnected) target.focus();
    }
    closeButton.addEventListener('click', close);
    cancelButton.addEventListener('click', close);
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      if (loaded) updatePrivacy(libraryRuntime.current());
      if (closed) return;
      if (privacyBlocked || privacyClosePending) { close(); return; }
      if ((paneKind === 'sync' || paneKind === 'recovery') && saving) return;
      if (paneKind) backToList(); else close();
    });
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const focusable = [...shadow.querySelectorAll('button,input,textarea,select,summary,a[href],[tabindex]')]
        .filter(item => !item.disabled && item.tabIndex >= 0 && !item.closest('.hidden') && item.getClientRects().length);
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = shadow.activeElement;
      if (event.shiftKey && (current === first || current === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (current === last || current === dialog)) { event.preventDefault(); first.focus(); }
    });
    try { dialog.showModal(); } catch (error) { close(); throw error; }
    closeButton.focus();

    function checkContext() {
      if (!privacyAllowsAction()) throw new Error('현재 계정이 확인되지 않아 작업을 중지했습니다.');
      const now = libraryRuntime.current();
      if (!loaded || now.accountId !== loaded.accountId || (now.chatId || null) !== (loaded.chatId || null) || now.generation !== loaded.generation) {
        throw new Error('계정 또는 채팅방이 변경되었습니다. 초안을 JSON으로 내보낸 뒤 현재 계정·채팅방에서 관리 창을 다시 열어 주세요.');
      }
    }
    function setDisabled(control, value) {
      if (privacyBlocked && control !== closeButton) {
        privacyControls.set(control, !!value);
        control.disabled = true;
      } else control.disabled = !!value;
    }
    function updatePrivacy(now) {
      if (closed || !loaded?.accountId) return false;
      if (now.accountId && now.accountId !== loaded.accountId) privacyClosePending = true;
      const blocked = !now.accountId || privacyClosePending;
      if (blocked) {
        privacyBlocked = true;
        for (const element of [context, counts, notice, workspace, pane, footer]) {
          if (!privacyDisplays.has(element)) privacyDisplays.set(element, { display: element.style.display, inert: element.inert });
          element.style.display = 'none';
          element.inert = true;
        }
        for (const control of shadow.querySelectorAll('button,input,textarea,select')) {
          if (control === closeButton) continue;
          if (!privacyControls.has(control)) privacyControls.set(control, control.disabled);
          control.disabled = true;
        }
        status.className = 'status error';
        status.textContent = privacyClosePending ? '계정이 변경되어 이전 라이브러리 창을 닫는 중입니다.' : '계정을 다시 확인하는 동안 라이브러리 내용을 숨겼습니다.';
        if (privacyClosePending && !saving) close();
        else if (!saving) { closeButton.disabled = false; closeButton.focus(); }
        return false;
      }
      if (privacyBlocked) {
        privacyBlocked = false;
        for (const [element, previous] of privacyDisplays) {
          element.style.display = previous.display;
          element.inert = previous.inert;
        }
        privacyDisplays.clear();
        for (const [control, disabled] of privacyControls) if (control.isConnected) control.disabled = disabled;
        privacyControls.clear();
        status.className = 'status';
        status.textContent = '계정을 다시 확인했습니다. 저장 전 변경은 유지됩니다.';
      }
      return true;
    }
    function privacyAllowsAction() {
      return !closed && !!loaded && updatePrivacy(libraryRuntime.current()) && !privacyBlocked && !privacyClosePending;
    }
    function downloadProtected(data, label) {
      if (!privacyAllowsAction()) return false;
      libraryUIDownload(data, label);
      return true;
    }
    function currentIds() { return LibraryCore.profile(draft, loaded.chatId || null).activeIds; }
    function currentPinnedIds() {
      const profile = LibraryCore.profile(draft, loaded.chatId || null);
      return profile.pinnedIds || profile.activeIds.filter(id => draft.library.find(entry => entry.id === id)?.isPinned);
    }
    function updateIds(ids, pinnedIds) {
      draft = LibraryCore.updateProfile(draft, loaded.chatId || null, ids, pinnedIds);
      profileTouched = true;
      markDirty();
    }
    function markDirty() {
      dirty = true;
      render();
    }
    function button(label, action, options = {}) {
      const control = libraryUIElement('button', options.className || '', label);
      control.type = 'button';
      if (options.title) control.title = options.title;
      if (options.ariaLabel) control.setAttribute('aria-label', options.ariaLabel);
      if (options.mutation !== false) mutationButtons.add(control);
      setDisabled(control, !!options.disabled);
      control.addEventListener('click', event => {
        if (!privacyAllowsAction() || busy || saving) return;
        try {
          const result = action(event);
          if (result && typeof result.catch === 'function') result.catch(error => say(libraryUIMessage(error), 'error'));
        } catch (error) { say(libraryUIMessage(error), 'error'); }
      });
      return control;
    }
    function setBusy(value) {
      busy = value;
      for (const control of mutationButtons) {
        if (control.isConnected) setDisabled(control, value);
        else mutationButtons.delete(control);
      }
      setDisabled(closeButton, saving);
      setDisabled(cancelButton, saving);
      setDisabled(search, value);
      setDisabled(activeTab, value);
      setDisabled(archiveTab, value);
      if (loaded) updatePrivacy(libraryRuntime.current());
      if (closed) return;
      if (!value && draft && !paneKind) render();
    }
    function backToList() {
      pane.replaceChildren();
      pane.classList.add('hidden');
      workspace.classList.remove('hidden');
      footer.classList.remove('hidden');
      paneKind = null;
      render();
      search.focus();
    }
    function openPane(kind, heading) {
      paneKind = kind;
      pane.replaceChildren(libraryUIElement('h3', '', heading));
      pane.classList.remove('hidden');
      workspace.classList.add('hidden');
      footer.classList.add('hidden');
      say('');
    }
    function sameName(name, excludeId) {
      const normalized = name.normalize('NFKC').trim().toLowerCase();
      return draft.library.find(entry => entry.id !== excludeId && entry.name.normalize('NFKC').trim().toLowerCase() === normalized);
    }
    function duplicateEntry(entry) {
      const stem = entry.name.replace(/\s+/g, '');
      let ending = '복사';
      let name = `${stem.slice(0, 10 - ending.length)}${ending}`;
      let suffix = 2;
      while (sameName(name)) {
        ending = `복사${suffix++}`;
        name = `${stem.slice(0, Math.max(0, 10 - ending.length))}${ending}`;
      }
      const next = LibraryCore.createEntry({ ...entry, name });
      draft = LibraryCore.validateState({ ...draft, library: [...draft.library, next] });
      markDirty();
      say(`“${name}”을 로컬 보관함에 복제했습니다. 저장 버튼을 눌러 반영하세요.`, 'success');
    }
    function editEntry(existing) {
      openPane('edit', existing ? '로컬 단축어 편집' : '로컬 단축어 만들기');
      const form = libraryUIElement('form');
      form.noValidate = true;
      const fields = {};
      function field(key, label, multiline, rows) {
        const wrapper = libraryUIElement('label', 'field');
        const input = libraryUIElement(multiline ? 'textarea' : 'input');
        if (!multiline) input.type = 'text';
        if (rows) input.rows = rows;
        input.value = key === 'extra' ? JSON.stringify(existing?.extra || { isPublic: false }, null, 2) : existing?.[key] || '';
        wrapper.append(libraryUIElement('span', '', label), input);
        fields[key] = input;
        form.append(wrapper);
      }
      field('name', '이름', false);
      fields.name.required = true;
      field('description', '설명', true, 2);
      field('body', '단축어 본문', true, 6);
      form.append(libraryUIElement('div', 'help', '확인된 Crack 입력 기준: 이름 1–10자·공백 없음, 설명 1–30자, 본문 1–400자. 가져온 원본은 자르지 않고 보존하며, 편집 적용 시 이 기준을 확인합니다.'));
      const pinWrapper = libraryUIElement('label', 'check');
      const pin = libraryUIElement('input');
      pin.type = 'checkbox';
      pin.checked = !!existing?.isPinned;
      pinWrapper.append(pin, libraryUIElement('span', '', '새 프리셋에 활성화할 때 기본 고정 그룹으로 표시'));
      form.append(pinWrapper);
      field('extra', '추가 설정 (JSON 객체)', true, 4);
      form.append(libraryUIElement('div', 'help', '기존 서버 항목의 prompt 본문과 확인된 추가 설정을 보존합니다. 추가 설정은 확인된 필드만 편집하세요. 서버 원본과 연결된 항목도 로컬 복사본만 변경되며, 변경 후 실제 실행은 미검증 상태가 됩니다.'));
      const actions = libraryUIElement('div', 'form-actions');
      const discard = button('돌아가기', backToList, { mutation: false });
      const apply = libraryUIElement('button', 'primary', '초안에 적용');
      apply.type = 'submit';
      actions.append(discard, apply);
      form.append(actions);
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (!privacyAllowsAction()) return;
        try {
          const name = fields.name.value.trim();
          if (!name || name.length > 10 || !/^\S+$/.test(name)) throw new Error('이름은 공백 없이 1–10자로 입력하세요. 가져온 원본은 자동으로 자르지 않습니다.');
          if (!fields.description.value.trim() || fields.description.value.length > 30) throw new Error('설명은 1–30자로 입력하세요. 가져온 원본은 자동으로 자르지 않습니다.');
          if (!fields.body.value.trim() || fields.body.value.length > 400) throw new Error('본문은 1–400자로 입력하세요. 가져온 원본은 자동으로 자르지 않습니다.');
          const unchangedName = !!existing && LibraryCore.nameKey(name) === LibraryCore.nameKey(existing.name);
          if (!unchangedName && sameName(name, existing?.id)) throw new Error('같은 이름의 단축어가 있습니다. 호출 충돌을 피하도록 이름을 변경하세요.');
          let extra;
          try { extra = JSON.parse(fields.extra.value); } catch { throw new Error('추가 설정은 올바른 JSON 객체여야 합니다.'); }
          if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('추가 설정은 JSON 객체여야 합니다.');
          if (typeof extra.isPublic !== 'boolean') throw new Error('확인된 추가 필수 설정 isPublic을 true 또는 false로 입력하세요.');
          const entry = LibraryCore.createEntry({ name, description: fields.description.value, body: fields.body.value, isPinned: pin.checked, extra }, existing);
          // Applying unchanged execution data or changing the local default pin
          // must not make an untouched server original ineligible for its preset.
          const stableExtra = value => JSON.stringify(value, (_key, item) =>
            item && typeof item === 'object' && !Array.isArray(item)
              ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
          if (existing && entry.name === existing.name && entry.description === existing.description &&
              entry.body === existing.body && stableExtra(entry.extra) === stableExtra(existing.extra)) {
            entry.dirty = existing.dirty;
          }
          const library = existing ? draft.library.map(item => item.id === existing.id ? entry : item) : [...draft.library, entry];
          draft = LibraryCore.validateState({ ...draft, library });
          dirty = true;
          backToList();
          say('로컬 초안에 반영했습니다. 저장 버튼을 눌러 보관하세요. 실제 실행 상태는 별도로 확인됩니다.', 'success');
        } catch (error) { say(libraryUIMessage(error), 'error'); }
      });
      pane.append(form);
      fields.name.focus();
    }
    function deleteEntry(entry) {
      openPane('delete', '로컬 라이브러리에서 삭제');
      pane.append(libraryUIElement('p', '', `“${entry.name}”을 로컬 라이브러리와 모든 채팅방·전역 프리셋에서 제거합니다. Crack 서버 원본은 유지됩니다. 저장 전에는 취소할 수 있습니다.`));
      const actions = libraryUIElement('div', 'form-actions');
      actions.append(button('돌아가기', backToList, { mutation: false }), button('삭제를 초안에 적용', () => {
        const candidate = libraryUIClone(draft);
        candidate.library = candidate.library.filter(item => item.id !== entry.id);
        candidate.settings.defaultIds = candidate.settings.defaultIds.filter(id => id !== entry.id);
        if (candidate.settings.defaultPinnedIds) candidate.settings.defaultPinnedIds = candidate.settings.defaultPinnedIds.filter(id => id !== entry.id);
        candidate.profiles = candidate.profiles.map(profile => ({ ...profile, activeIds: profile.activeIds.filter(id => id !== entry.id), ...(profile.pinnedIds ? { pinnedIds: profile.pinnedIds.filter(id => id !== entry.id) } : {}) }));
        draft = LibraryCore.validateState(candidate);
        dirty = true;
        backToList();
        say('로컬 삭제를 초안에 반영했습니다. 저장해야 확정됩니다.');
      }, { className: 'danger' }));
      pane.append(actions);
      actions.firstElementChild.focus();
    }
    function move(id, delta) {
      const ids = currentIds().slice();
      const pinned = new Set(currentPinnedIds());
      const group = ids.filter(itemId => pinned.has(itemId) === pinned.has(id));
      const position = group.indexOf(id);
      const targetId = group[position + delta];
      if (!targetId) return;
      const sourceIndex = ids.indexOf(id);
      const targetIndex = ids.indexOf(targetId);
      [ids[sourceIndex], ids[targetIndex]] = [ids[targetIndex], ids[sourceIndex]];
      updateIds(ids);
      const row = [...scroll.querySelectorAll('[data-entry-id]')].find(item => item.dataset.entryId === id);
      const control = row?.querySelector(delta < 0 ? '[data-up]' : '[data-down]');
      if (control && !control.disabled) control.focus();
      else row?.querySelector('.draghandle')?.focus();
    }
    function moveOnto(fromId, toId) {
      if (!fromId || fromId === toId || tabName !== 'active') return;
      const from = draft.library.find(item => item.id === fromId);
      const to = draft.library.find(item => item.id === toId);
      const pinned = new Set(currentPinnedIds());
      if (!from || !to || pinned.has(fromId) !== pinned.has(toId)) { say('고정·일반 그룹 안에서만 순서를 바꿀 수 있습니다.'); return; }
      const ids = currentIds().slice();
      const groupSlots = ids.map((id, index) => ({ id, index })).filter(({ id }) => pinned.has(id) === pinned.has(fromId));
      const groupIds = groupSlots.map(slot => slot.id);
      const fromIndex = groupIds.indexOf(fromId);
      const toIndex = groupIds.indexOf(toId);
      if (fromIndex < 0 || toIndex < 0) return;
      groupIds.splice(fromIndex, 1);
      groupIds.splice(toIndex, 0, fromId);
      groupSlots.forEach((slot, index) => { ids[slot.index] = groupIds[index]; });
      updateIds(ids);
    }
    function render() {
      if (!draft || closed || !privacyAllowsAction()) return;
      const focusedControl = shadow.activeElement;
      const focusedEntry = focusedControl?.closest('[data-entry-id]')?.dataset.entryId;
      const focusedLabel = focusedControl?.textContent;
      const previousScrollTop = scroll.scrollTop;
      const ids = currentIds();
      const activeSet = new Set(ids);
      const pinnedSet = new Set(currentPinnedIds());
      counts.textContent = `선택 단축어 ${ids.length} / 50 · 로컬 라이브러리 ${draft.library.length}개${dirty ? ' · 저장 전 변경 있음' : ''}`;
      activeTab.textContent = `활성 단축어 (${ids.length})`;
      archiveTab.textContent = `보관함 (${draft.library.length - ids.length})`;
      activeTab.setAttribute('aria-selected', String(tabName === 'active'));
      archiveTab.setAttribute('aria-selected', String(tabName === 'archive'));
      activeTab.tabIndex = tabName === 'active' ? 0 : -1;
      archiveTab.tabIndex = tabName === 'archive' ? 0 : -1;
      scroll.setAttribute('aria-labelledby', tabName === 'active' ? activeTab.id : archiveTab.id);
      scroll.replaceChildren();
      for (const control of mutationButtons) if (!control.isConnected) mutationButtons.delete(control);
      const query = search.value.normalize('NFKC').trim().toLowerCase();
      const matches = entry => !query || `${entry.name}\n${entry.description}\n${entry.body}`.normalize('NFKC').toLowerCase().includes(query);
      const entryMap = new Map(draft.library.map(entry => [entry.id, entry]));
      const entries = tabName === 'active' ? ids.map(id => entryMap.get(id)).filter(Boolean) : draft.library.filter(entry => !activeSet.has(entry.id));
      const matching = entries.filter(matches);
      if (!matching.length) {
        scroll.append(libraryUIElement('div', 'empty', query ? '검색 결과가 없습니다.' : tabName === 'active' ? '이 프리셋에 선택한 단축어가 없습니다. 보관함에서 활성화하세요.' : '현재 프리셋에서 사용하지 않는 단축어가 없습니다.'));
        if (focusedEntry) (tabName === 'active' ? activeTab : archiveTab).focus();
        return;
      }
      for (const pin of [true, false]) {
        const group = matching.filter(entry => (tabName === 'active' ? pinnedSet.has(entry.id) : entry.isPinned) === pin);
        if (!group.length) continue;
        const heading = libraryUIElement('h3', '', pin ? '고정' : '일반');
        const rows = libraryUIElement('div', 'rows');
        for (const entry of group) {
          const row = libraryUIElement('article', 'row');
          row.dataset.entryId = entry.id;
          const rowHead = libraryUIElement('div', 'row-head');
          const content = libraryUIElement('div', 'grow');
          content.append(libraryUIElement('div', 'name', entry.name));
          if (entry.description) content.append(libraryUIElement('div', 'description', entry.description));
          const execution = libraryRuntime.executionStatus(entry);
          content.append(libraryUIElement('div', 'execution', typeof execution === 'string' ? execution : execution?.label || '실행 미검증 · 로컬 저장 항목'));
          rowHead.append(content);
          const actions = libraryUIElement('div', 'row-actions');
          if (tabName === 'active') {
            const allGroupIds = ids.filter(id => pinnedSet.has(id) === pin);
            const position = allGroupIds.indexOf(entry.id);
            const up = button('▲', () => move(entry.id, -1), { disabled: position === 0, ariaLabel: `${entry.name} 위로 이동` });
            const down = button('▼', () => move(entry.id, 1), { disabled: position === allGroupIds.length - 1, ariaLabel: `${entry.name} 아래로 이동` });
            up.setAttribute('data-up', '');
            down.setAttribute('data-down', '');
            const handle = button('↕', () => {}, { className: 'draghandle', ariaLabel: `${entry.name} 드래그 정렬 (키보드는 위·아래 이동 버튼 사용)` });
            handle.draggable = true;
            handle.addEventListener('dragstart', event => { draggedId = entry.id; row.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', entry.id); });
            handle.addEventListener('dragend', () => { draggedId = null; row.classList.remove('dragging'); for (const item of scroll.querySelectorAll('.dragover')) item.classList.remove('dragover'); });
            handle.addEventListener('pointerdown', event => {
              if (event.pointerType === 'mouse' || event.button !== 0) return;
              event.preventDefault();
              pointerDrag = { id: entry.id, pointerId: event.pointerId, targetId: null, handle };
              handle.setPointerCapture(event.pointerId);
              row.classList.add('dragging');
            });
            row.addEventListener('dragover', event => { if (draggedId && pinnedSet.has(draggedId) === pinnedSet.has(entry.id)) { event.preventDefault(); row.classList.add('dragover'); } });
            row.addEventListener('dragleave', () => row.classList.remove('dragover'));
            row.addEventListener('drop', event => { event.preventDefault(); row.classList.remove('dragover'); moveOnto(draggedId, entry.id); });
            actions.append(handle, up, down, button(pin ? '고정 해제' : '고정', () => {
              const pins = currentPinnedIds();
              updateIds(currentIds(), pin ? pins.filter(id => id !== entry.id) : [...pins, entry.id]);
              say('현재 프리셋의 고정 그룹만 변경했습니다. 다른 채팅방은 유지됩니다.');
            }), button('보관', () => { updateIds(ids.filter(id => id !== entry.id)); say('현재 프리셋에서만 제외했습니다. 본문은 로컬 라이브러리에 유지됩니다.'); }));
          } else {
            actions.append(button('활성화', () => {
              if (currentIds().length >= 50) throw new Error('한 프리셋에는 최대 50개까지 선택할 수 있습니다. 먼저 다른 단축어를 보관하세요.');
              const collision = currentIds().map(id => entryMap.get(id)).find(other => other && other.name.normalize('NFKC').trim().toLowerCase() === entry.name.normalize('NFKC').trim().toLowerCase());
              if (collision) throw new Error('현재 프리셋에 같은 이름의 단축어가 있습니다. 호출 충돌을 피하도록 이름을 변경하세요.');
              updateIds([...currentIds(), entry.id]);
              say('현재 프리셋에 선택했습니다. 실제 실행 상태는 각 항목의 안내를 확인하세요.');
            }, { disabled: ids.length >= 50 }));
          }
          actions.append(button('편집', () => editEntry(entry)), button('복제', () => duplicateEntry(entry)), button('삭제', () => deleteEntry(entry), { className: 'danger' }));
          row.append(rowHead, actions);
          rows.append(row);
        }
        scroll.append(heading, rows);
      }
      setDisabled(saveButton, busy || saving);
      setDisabled(reloadButton, busy || saving);
      scroll.scrollTop = previousScrollTop;
      if (focusedEntry) {
        const row = [...scroll.querySelectorAll('[data-entry-id]')].find(item => item.dataset.entryId === focusedEntry);
        const control = row && [...row.querySelectorAll('button')].find(item => item.textContent === focusedLabel && !item.disabled);
        (control || row?.querySelector('button:not(:disabled)') || (tabName === 'active' ? activeTab : archiveTab)).focus();
      }
    }
    shadow.addEventListener('pointermove', event => {
      if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
      event.preventDefault();
      const target = shadow.elementFromPoint(event.clientX, event.clientY)?.closest('[data-entry-id]');
      for (const row of scroll.querySelectorAll('.dragover')) row.classList.remove('dragover');
      pointerDrag.targetId = target?.dataset.entryId || null;
      if (target && pointerDrag.targetId !== pointerDrag.id) target.classList.add('dragover');
      const rect = scroll.getBoundingClientRect();
      if (event.clientY < rect.top + 35) scroll.scrollTop -= 15;
      else if (event.clientY > rect.bottom - 35) scroll.scrollTop += 15;
    });
    function finishPointerDrag(event) {
      if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
      const drag = pointerDrag;
      pointerDrag = null;
      try { drag.handle.releasePointerCapture(event.pointerId); } catch { /* Capture may already be released. */ }
      for (const row of scroll.querySelectorAll('.dragging,.dragover')) row.classList.remove('dragging', 'dragover');
      if (event.type !== 'pointercancel') moveOnto(drag.id, drag.targetId);
    }
    shadow.addEventListener('pointerup', finishPointerDrag);
    shadow.addEventListener('pointercancel', finishPointerDrag);
    search.addEventListener('input', render);
    for (const [tab, name] of [[activeTab, 'active'], [archiveTab, 'archive']]) {
      tab.addEventListener('click', () => { tabName = name; render(); });
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        tabName = event.key === 'Home' ? 'active' : event.key === 'End' ? 'archive' : tabName === 'active' ? 'archive' : 'active';
        render();
        (tabName === 'active' ? activeTab : archiveTab).focus();
      });
    }
    async function save(reload) {
      if (!draft || !privacyAllowsAction() || busy || saving) return;
      try {
        checkContext();
        if (stale) throw new Error('revision conflict');
        const candidate = libraryUIClone(draft);
        if (!loaded.chatId && profileTouched) candidate.sync.defaultConfigured = true;
        const checked = LibraryCore.validateState(candidate);
        saving = true;
        setBusy(true);
        say('로컬 저장 및 네이티브 목록 반영 중…');
        const committed = await libraryRuntime.save(checked, loaded.state.revision);
        if (closed) return;
        const now = libraryRuntime.current();
        if (now.accountId !== loaded.accountId || now.generation !== loaded.generation || (now.chatId || null) !== (loaded.chatId || null)) {
          saving = false;
          stale = true;
          dirty = false;
          setBusy(false);
          say('로컬 저장은 완료되었지만 계정 또는 채팅방이 변경되었습니다. 새로고침을 수행하지 않았습니다. 관리 창을 다시 열어 현재 상태를 확인하세요.', 'error');
          return;
        }
        loaded.state = LibraryCore.validateState(committed);
        draft = libraryUIClone(loaded.state);
        dirty = false;
        setDisabled(closeButton, false);
        setDisabled(cancelButton, false);
        saving = false;
        if (!reload && now.nativeApplication && now.nativeApplication.phase !== 'applied') {
          setBusy(false);
          say(now.nativeApplication.message, now.nativeApplication.phase === 'failed' ? 'error' : '');
          return;
        }
        close();
        if (reload) window.location.reload();
      } catch (error) {
        saving = false;
        setBusy(false);
        say(libraryUIMessage(error), 'error');
      }
    }
    saveButton.addEventListener('click', () => save(false));
    reloadButton.addEventListener('click', () => save(true));
    restoreButton.addEventListener('click', () => {
      if (!draft || !privacyAllowsAction() || busy) return;
      openPane('restore', '기본 프리셋 복원');
      pane.append(libraryUIElement('p', '', loaded.chatId ? '현재 채팅방의 선택과 순서를 전역 기본 프리셋으로 되돌립니다. 다른 채팅방과 라이브러리 본문은 유지됩니다.' : '전역 기본 프리셋의 선택 목록을 비웁니다. 저장된 채팅방 프리셋과 라이브러리 본문은 유지됩니다.'));
      const actions = libraryUIElement('div', 'form-actions');
      actions.append(button('돌아가기', backToList, { mutation: false }), button('복원을 초안에 적용', () => {
        const defaults = LibraryCore.profile(draft, null);
        updateIds(loaded.chatId ? defaults.activeIds.slice() : [], loaded.chatId ? (defaults.pinnedIds || []).slice() : []);
        backToList();
        say('기본 프리셋 복원을 초안에 반영했습니다. 저장해야 확정됩니다.');
      }, { className: 'primary' }));
      pane.append(actions);
      actions.firstElementChild.focus();
    });

    async function checkRecoveryRecord(journal) {
      checkContext();
      if (!journal || typeof journal.id !== 'string' || journal.accountId !== loaded.accountId) throw new Error('현재 계정의 복구 기록을 확인하지 못했습니다.');
      if (typeof libraryRuntime.checkRecovery !== 'function') throw new Error('현재 버전에서 복구 상태 확인 기능을 찾지 못했습니다.');
      saving = true;
      setBusy(true);
      say('서버 원본 내용과 복구 기록을 확인하는 중…');
      try {
        const result = await libraryRuntime.checkRecovery(journal.id);
        if (closed) return null;
        if (!result?.state || typeof result.resolved !== 'boolean') throw new Error('복구 확인 결과를 읽지 못했습니다. 기존 기록은 유지됩니다.');
        loaded.state = LibraryCore.validateState(result.state);
        draft = libraryUIClone(loaded.state);
        dirty = false;
        checkContext();
        return result;
      } finally {
        saving = false;
        if (!closed) setBusy(false);
      }
    }
    function recoveryPreview(error) {
      let journal = libraryUIClone(error.journal);
      let recovery = error.recovery ? libraryUIClone(error.recovery) : null;
      openPane('recovery', '서버 적용 복구 기록');
      pane.append(libraryUIElement('p', 'help', '이전 서버 적용 기록이 남아 있어 새 서버 변경을 중지했습니다. 기록과 백업을 보관한 뒤 Crack에서 필요한 원본을 복원하세요. “복구 상태 확인”은 서버에 내용을 쓰지 않고 원본 내용이 있는지 확인합니다. 서버 ID와 채팅방 고정 상태가 이전과 같다고 보장하지 않습니다.'));
      const message = libraryUIElement('div', 'preview', libraryUIMessage(error));
      message.setAttribute('role', 'status');
      const downloads = libraryUIElement('div', 'toolbar');
      const downloadJournal = button('복구 기록 다운로드', () => {
        downloadProtected({ format: 'crack-shortcut-sync-recovery', schemaVersion: 1, accountId: loaded.accountId, chatId: loaded.chatId, exportedAt: new Date().toISOString(), journal, recovery, library: LibraryCore.exportBackup(draft, null, loaded.accountId) }, 'sync-recovery');
      }, { mutation: false });
      downloads.append(downloadJournal, button('로컬 라이브러리 백업', () => downloadProtected(LibraryCore.exportBackup(draft, null, loaded.accountId), 'library'), { mutation: false }));
      const actions = libraryUIElement('div', 'form-actions');
      const check = button('복구 상태 확인', async () => {
        try {
          const result = await checkRecoveryRecord(journal);
          if (!result || closed) return;
          journal = result.journal || journal;
          recovery = journal.recovery || recovery;
          const text = typeof result.message === 'string' ? result.message : result.resolved ? '기록의 원본 내용이 서버에 있는 것을 확인했습니다. 서버 ID와 고정 상태 복원을 확인한 것은 아닙니다.' : '원본 내용의 복구가 아직 확인되지 않았습니다. 원본을 복원한 뒤 다시 확인하세요.';
          message.textContent = text;
          say(text, result.resolved ? 'success' : 'error');
          setDisabled(check, result.resolved);
        } catch (failure) {
          if (failure.journal) journal = libraryUIClone(failure.journal);
          const text = `복구 확인을 완료하지 못했습니다. ${libraryUIMessage(failure)}`;
          message.textContent = text;
          say(text, 'error');
        }
      });
      actions.append(button('돌아가기', backToList, { mutation: false }), check);
      pane.append(message, downloads, actions);
      say('기록과 백업은 유지됩니다. 복구 확인에서 서버 등록·삭제는 하지 않습니다.');
      downloadJournal.focus();
    }

    function syncPreview(prepared) {
      const summary = prepared?.summary;
      if (!prepared?.plan || !prepared.backup || !summary || summary.limit !== 50 ||
          !Number.isSafeInteger(summary.beforeCount) || !Number.isSafeInteger(summary.afterCount) ||
          summary.beforeCount < 0 || summary.afterCount < 0 || summary.afterCount > 50 ||
          !['creates', 'deletes', 'reused', 'protected'].every(key => Array.isArray(summary[key]) && summary[key].every(item => item && typeof item.name === 'string')) ||
          !Array.isArray(summary.warnings) || !summary.warnings.every(item => typeof item === 'string')) {
        throw new Error('서버 변경 계획을 확인하지 못했습니다. 서버에는 적용하지 않았습니다.');
      }
      const plan = libraryUIClone(prepared.plan);
      const backup = libraryUIClone(prepared.backup);
      openPane('sync', '네이티브 적용 계획');
      pane.append(libraryUIElement('p', 'help', '현재 로컬 변경은 저장되었습니다. 아래 내용을 확인하고 동의해야 서버에 반영됩니다. 서버의 50개 슬롯은 계정 전체에서 공유하므로 다른 채팅방에도 영향을 줄 수 있습니다.'));
      const preview = libraryUIElement('div', 'preview');
      const names = (items, publicMarkers = false) => items.length ? items.map(item => `/${item.name}${publicMarkers && item.isPublic === true ? ' [공개]' : ''}`).join(', ') : '없음';
      preview.textContent = `서버 슬롯: ${summary.beforeCount} / 50 → ${summary.afterCount} / 50\n\n새 등록 ${summary.creates.length}개: ${names(summary.creates, true)}\n삭제 ${summary.deletes.length}개: ${names(summary.deletes)}\n그대로 사용 ${summary.reused.length}개: ${names(summary.reused)}\n보호된 원본 ${summary.protected.length}개: ${names(summary.protected)}${summary.warnings.length ? `\n\n${summary.warnings.join('\n')}` : ''}`;
      pane.append(preview, libraryUIElement('p', 'help', '서버 전체 원본과 로컬 라이브러리 백업을 내려받아 보관하세요. 보호된 공개 원본은 변경하지 않습니다. 삭제한 실행용 슬롯을 복구하면 서버 ID가 달라질 수 있습니다. 다른 채팅방으로 이동할 때 서버 슬롯을 자동 교체하지 않습니다.'));
      const changes = [
        ...(plan.removes || []).filter(item=>item.raw).map(item=>`삭제할 원본 /${item.name}\n사유: ${item.reason}\n설명: ${item.raw.description}\n본문:\n${item.raw.prompt}`),
        ...(plan.creates || []).filter(item=>item.fields).map(item=>`등록할 단축어 /${item.name}${item.fields.isPublic?' [공개]':' [비공개]'}\n설명: ${item.fields.description}\n본문:\n${item.fields.prompt}`)
      ];
      if (changes.length) {
        const details = libraryUIElement('details', 'help');
        details.append(libraryUIElement('summary', '', '본문을 포함한 변경 내용 확인'),libraryUIElement('div', 'preview', changes.join('\n\n──────────\n\n')));
        pane.append(details);
      }
      let backupRequested = false;
      let finished = false;
      let journal = null;
      let recovery = null;
      const downloadBackup = button('서버 전체 백업 다운로드', () => {
        if (!downloadProtected(backup, 'server-backup')) return;
        backupRequested = true;
        setDisabled(backupCheck, false);
        updateConsent();
        say('백업 다운로드를 요청했습니다. 파일을 실제로 보관한 뒤 아래 확인을 선택하세요.');
      }, { mutation: false });
      const downloadLocal = button('로컬 라이브러리 백업', () => downloadProtected(LibraryCore.exportBackup(draft, null, loaded.accountId), 'library'), { mutation: false });
      const downloadJournal = button('복구 기록 다운로드', () => {
        if (!journal && !recovery) throw new Error('내려받을 처리 기록이 없습니다.');
        downloadProtected({ format: 'crack-shortcut-sync-recovery', schemaVersion: 1, accountId: loaded.accountId, chatId: loaded.chatId, exportedAt: new Date().toISOString(), journal, recovery, backup, library: LibraryCore.exportBackup(draft, null, loaded.accountId) }, 'sync-recovery');
      }, { mutation: false });
      downloadJournal.classList.add('hidden');
      const checkRecovery = button('복구 상태 확인', async () => {
        try {
          const result = await checkRecoveryRecord(journal);
          if (!result || closed) return;
          journal = result.journal || journal;
          recovery = journal.recovery || recovery;
          const text = typeof result.message === 'string' ? result.message : result.resolved ? '원본 내용 확인을 완료했습니다. 서버 ID와 고정 상태가 이전과 같다고 보장하지 않습니다.' : '원본 내용의 복구가 아직 확인되지 않았습니다. 복원 후 다시 확인하세요.';
          resultMessage.textContent = text;
          say(text, result.resolved ? 'success' : 'error');
          setDisabled(checkRecovery, result.resolved);
        } catch (failure) {
          if (failure.journal) journal = libraryUIClone(failure.journal);
          const text = `복구 확인을 완료하지 못했습니다. ${libraryUIMessage(failure)}`;
          resultMessage.textContent = text;
          say(text, 'error');
        } finally { updateConsent(); }
      });
      checkRecovery.classList.add('hidden');
      const downloads = libraryUIElement('div', 'toolbar');
      downloads.append(downloadBackup, downloadLocal, downloadJournal, checkRecovery);
      pane.append(downloads);
      function confirmation(text) {
        const wrapper = libraryUIElement('label', 'check');
        const input = libraryUIElement('input');
        input.type = 'checkbox';
        wrapper.append(input, libraryUIElement('span', '', text));
        pane.append(wrapper);
        input.addEventListener('change', updateConsent);
        return input;
      }
      const backupCheck = confirmation('서버 전체 백업 파일을 다운로드해 보관했습니다.');
      setDisabled(backupCheck, true);
      const serverCheck = confirmation(`위 계획의 서버 등록 ${summary.creates.length}개·삭제 ${summary.deletes.length}개와 계정 전체 슬롯 변경에 동의합니다.`);
      const tabsCheck = summary.deletes.length ? confirmation('다른 Crack 채팅 탭을 모두 닫았습니다.') : null;
      const resultMessage = libraryUIElement('div', 'help');
      resultMessage.setAttribute('role', 'status');
      pane.append(resultMessage);
      const actions = libraryUIElement('div', 'form-actions');
      const back = button('돌아가기', () => {
        backToList();
        say('현재 로컬 변경은 저장되어 있습니다. 서버 변경은 별도의 네이티브 적용에서만 진행합니다.');
      }, { mutation: false });
      const apply = button('동의한 계획 적용', async () => {
        try {
          checkContext();
          if (stale || (typeof libraryRuntime.current().revision === 'number' && libraryRuntime.current().revision !== loaded.state.revision)) throw new Error('revision conflict');
          if (!backupRequested || !backupCheck.checked || !serverCheck.checked || (tabsCheck && !tabsCheck.checked)) throw new Error('백업 보관과 서버 변경 동의를 확인하세요. 삭제가 있으면 다른 채팅 탭도 닫아야 합니다.');
          if (finished) throw new Error('처리한 계획은 다시 실행할 수 없습니다. 돌아가서 새 계획을 확인하세요.');
          finished = true;
          saving = true;
          setBusy(true);
          for (const input of [backupCheck, serverCheck, tabsCheck].filter(Boolean)) setDisabled(input, true);
          say('동의한 서버 변경을 적용하고 등록 결과를 확인하는 중…');
          const result = await libraryRuntime.applySync(plan, { consent: true });
          if (closed) return;
          journal = result?.journal || null;
          if (journal) { downloadJournal.classList.remove('hidden'); checkRecovery.classList.remove('hidden'); }
          if (!result?.state) throw new Error('서버 처리 후 로컬 저장 상태를 확인하지 못했습니다. 백업과 복구 기록을 보관하세요.');
          loaded.state = LibraryCore.validateState(result.state);
          draft = libraryUIClone(loaded.state);
          dirty = false;
          checkContext();
          const application = result.application;
          const message = application?.phase === 'applied' ? '서버 등록과 네이티브 목록 반영을 확인했습니다. 실제 채팅 실행 결과는 별도로 확인하세요.' : (typeof application?.message === 'string' ? application.message : '네이티브 목록 반영 결과를 확인하지 못했습니다. 처리 기록을 내려받아 확인하세요.');
          resultMessage.textContent = message;
          say(message, application?.phase === 'applied' ? 'success' : 'error');
        } catch (error) {
          journal = error?.journal || journal;
          recovery = error?.recovery || null;
          if (journal || recovery) downloadJournal.classList.remove('hidden');
          if (journal) checkRecovery.classList.remove('hidden');
          if (error?.localState) {
            try {
              loaded.state = LibraryCore.validateState(error.localState);
              draft = libraryUIClone(loaded.state);
              dirty = false;
            } catch { /* The current draft and downloadable backup stay intact. */ }
          }
          const message = `네이티브 적용을 완료하지 못했습니다. ${libraryUIMessage(error)}${journal || recovery ? ' 복구 기록과 백업을 내려받아 보관하세요.' : ''}`;
          resultMessage.textContent = message;
          say(message, 'error');
        } finally {
          saving = false;
          if (!closed) { setBusy(false); updateConsent(); }
        }
      }, { className: 'primary', disabled: true });
      function updateConsent() {
        setDisabled(apply, busy || saving || finished || stale || !backupRequested || !backupCheck.checked || !serverCheck.checked || !!(tabsCheck && !tabsCheck.checked));
      }
      actions.append(back, apply);
      pane.append(actions);
      updateConsent();
      downloadBackup.focus();
      say('로컬 변경을 저장했습니다. 서버 변경은 아직 시작하지 않았습니다.');
    }

    async function prepareManualSync() {
      if (!draft || !privacyAllowsAction() || busy || saving) return;
      let prepared = null;
      let pendingRecovery = null;
      try {
        checkContext();
        if (!loaded.chatId) throw new Error('네이티브 적용은 단축어를 사용할 채팅방에서 진행하세요.');
        if (stale) throw new Error('revision conflict');
        if (typeof libraryRuntime.prepareSync !== 'function' || typeof libraryRuntime.applySync !== 'function') throw new Error('현재 버전에서 서버 적용 기능을 확인하지 못했습니다.');
        saving = true;
        setBusy(true);
        say('로컬 변경을 저장하고 서버 적용 계획을 확인하는 중…');
        const committed = await libraryRuntime.save(LibraryCore.validateState(libraryUIClone(draft)), loaded.state.revision);
        if (closed) return;
        loaded.state = LibraryCore.validateState(committed);
        draft = libraryUIClone(loaded.state);
        dirty = false;
        checkContext();
        prepared = await libraryRuntime.prepareSync(libraryUIClone(draft), { accountId: loaded.accountId, chatId: loaded.chatId, generation: loaded.generation, revision: loaded.state.revision });
        if (closed) return;
        checkContext();
        const now = libraryRuntime.current();
        if (typeof now.revision === 'number' && now.revision !== loaded.state.revision) throw new Error('revision conflict');
      } catch (error) {
        prepared = null;
        if (error?.journal) pendingRecovery = error;
        if (!closed) say(`서버 적용 계획을 만들지 못했습니다. ${libraryUIMessage(error)}`, 'error');
      } finally {
        saving = false;
        if (!closed) setBusy(false);
      }
      if (pendingRecovery && !closed) {
        try { recoveryPreview(pendingRecovery); }
        catch (error) { say(libraryUIMessage(error), 'error'); }
      } else if (prepared && !closed) {
        try { syncPreview(prepared); }
        catch (error) { say(libraryUIMessage(error), 'error'); }
      }
    }

    function importPreview(parsed) {
      openPane('import', '백업 가져오기 미리보기');
      const explanation = libraryUIElement('p', 'help', '아래 선택은 현재 초안에만 적용됩니다. 저장 버튼을 눌러야 브라우저 라이브러리에 반영됩니다. 병합은 같은 ID·서버 원본의 기존 내용을 유지합니다.');
      const mode = libraryUIElement('div', 'mode');
      const preview = libraryUIElement('div', 'preview');
      const consentWrapper = libraryUIElement('label', 'check hidden');
      const consent = libraryUIElement('input');
      consent.type = 'checkbox';
      consentWrapper.append(consent, libraryUIElement('span', '', '현재 데이터가 백업 내용으로 덮어써지는 것에 동의합니다.'));
      let modeValue = 'merge';
      let candidate = null;
      const apply = button('병합을 초안에 적용', () => {
        if (!candidate) throw new Error('백업 미리보기를 확인할 수 없습니다.');
        if (modeValue === 'replace' && !consent.checked) throw new Error('덮어쓰기 확인을 선택하세요.');
        draft = LibraryCore.validateState(candidate.state);
        dirty = true;
        backToList();
        say('백업을 초안에 반영했습니다. 저장 전 취소하면 기존 데이터가 유지됩니다.', 'success');
      }, { className: 'primary' });
      function previewMode() {
        try {
          candidate = LibraryCore.mergeBackup(draft, parsed, modeValue);
          const conflict = candidate.conflicts;
          const nameDetails = (conflict.names || []).slice(0, 8).map(item => typeof item === 'string' ? item : JSON.stringify(item)).join(', ');
          preview.textContent = `적용 후 라이브러리: ${candidate.state.library.length}개\n추가 항목: ${conflict.addedEntries || 0}개 · 변경 항목: ${conflict.changedEntries || 0}개\nID/서버 원본 충돌: ${(conflict.entryIds || []).length}개\n이름 충돌: ${(conflict.names || []).length}개${nameDetails ? ` (${nameDetails})` : ''}\n프리셋 충돌: ${(conflict.profiles || []).length}개 · 전역 설정 충돌: ${conflict.settings ? '있음' : '없음'}\n${modeValue === 'merge' ? '충돌하는 기존 항목·프리셋은 유지됩니다.' : parsed.scope?.type === 'chat' ? '채팅방 백업에 포함된 항목과 해당 프리셋을 교체합니다.' : '전체 백업 교체는 기존 라이브러리·프리셋·설정을 덮어씁니다.'}`;
          consentWrapper.classList.toggle('hidden', modeValue !== 'replace');
          apply.textContent = modeValue === 'merge' ? '병합을 초안에 적용' : '교체를 초안에 적용';
          setDisabled(apply, false);
        } catch (error) {
          candidate = null;
          setDisabled(apply, true);
          preview.textContent = libraryUIMessage(error);
        }
      }
      for (const [value, label] of [['merge', '기존 내용 유지·병합'], ['replace', '백업 내용으로 교체']]) {
        const wrapper = libraryUIElement('label', 'check');
        const radio = libraryUIElement('input');
        radio.type = 'radio';
        radio.name = 'library-import-mode';
        radio.value = value;
        radio.checked = value === modeValue;
        radio.addEventListener('change', () => { modeValue = value; consent.checked = false; previewMode(); });
        wrapper.append(radio, libraryUIElement('span', '', label));
        mode.append(wrapper);
      }
      const actions = libraryUIElement('div', 'form-actions');
      actions.append(button('돌아가기', backToList, { mutation: false }), apply);
      pane.append(explanation, mode, preview, consentWrapper, actions);
      previewMode();
      mode.querySelector('input').focus();
    }

    try {
      loaded = await libraryRuntime.openState();
      if (closed) return;
      if (!loaded?.accountId || !loaded.state) {
        context.textContent = '계정이 확인되지 않아 데이터 접근이 보호되고 있습니다.';
        say(libraryUIStatusText(loaded?.status), 'error');
        workspace.classList.add('hidden');
        for (const control of [restoreButton, saveButton, reloadButton]) control.classList.add('hidden');
        return;
      }
      draft = LibraryCore.validateState(libraryUIClone(loaded.state));
      context.textContent = loaded.chatId ? `현재 채팅방: ${loaded.chatId}${LibraryCore.profile(draft, loaded.chatId).inherited ? ' · 전역 기본 프리셋 상속' : ''}` : '전역 기본 프리셋 · 새 채팅방에서 상속';
      const importServer = button('서버 단축어 가져오기', async () => {
        checkContext();
        setBusy(true);
        say('확인된 서버 단축어를 로컬 초안으로 가져오는 중…');
        try {
          const next = await libraryRuntime.importServer(libraryUIClone(draft));
          checkContext();
          if (closed) return;
          draft = LibraryCore.validateState(next?.state || next);
          dirty = true;
          say('서버 단축어를 로컬 초안에 가져왔습니다. 서버 원본은 유지되며, 저장 버튼을 눌러 보관하세요.', 'success');
        } finally { if (!closed) setBusy(false); }
      });
      const newEntry = button('새 단축어', () => editEntry(null));
      const nativeApply = button('네이티브 적용', prepareManualSync, { className: 'primary', disabled: !loaded.chatId, mutation: !!loaded.chatId });
      if (!loaded.chatId) nativeApply.title = '단축어를 사용할 채팅방에서 서버 적용 계획을 확인할 수 있습니다.';
      const exportAll = button('전체 JSON 내보내기', () => {
        downloadProtected(LibraryCore.exportBackup(draft, null, loaded.accountId), 'library');
        say(dirty ? '저장 전 초안을 포함한 전체 백업을 내보냈습니다.' : '전체 라이브러리 백업을 내보냈습니다.', 'success');
      }, { mutation: false });
      const exportProfile = button('현재 프리셋 내보내기', () => {
        downloadProtected(LibraryCore.exportBackup(draft, loaded.chatId || undefined, loaded.accountId), loaded.chatId ? 'chat-profile' : 'default-profile');
        say('현재 프리셋 백업을 내보냈습니다.', 'success');
      }, { mutation: false });
      if (!loaded.chatId) { setDisabled(exportProfile, true); exportProfile.title = '채팅방에서 해당 프리셋을 내보낼 수 있습니다.'; }
      const importFile = libraryUIElement('input', 'hidden');
      importFile.type = 'file';
      importFile.accept = '.json,application/json';
      importFile.setAttribute('aria-label', '가져올 JSON 백업 파일');
      const importButton = button('JSON 가져오기', () => importFile.click());
      importFile.addEventListener('change', async () => {
        const file = importFile.files?.[0];
        importFile.value = '';
        if (!file || closed || !privacyAllowsAction()) return;
        try {
          checkContext();
          if (file.size > LibraryCore.MAX_BACKUP_BYTES) throw new Error('백업 파일은 32MB 이하로 가져올 수 있습니다.');
          setBusy(true);
          say('백업 스키마와 계정, 충돌 항목을 확인하는 중…');
          const parsed = LibraryCore.parseBackup(await file.text(), loaded.accountId);
          if (closed) return;
          checkContext();
          setBusy(false);
          importPreview(parsed);
        } catch (error) { if (!closed) { setBusy(false); say(`백업을 가져오지 않았습니다. ${libraryUIMessage(error)}`, 'error'); } }
      });
      toolbar.append(importServer, newEntry, nativeApply, exportAll, importButton, exportProfile, importFile);
      unsubscribe = libraryRuntime.subscribe(() => {
        if (closed) return;
        const now = libraryRuntime.current();
        if (!updatePrivacy(now) || closed || saving) return;
        if (now.accountId !== loaded.accountId || (now.chatId || null) !== (loaded.chatId || null) || now.generation !== loaded.generation) {
          stale = true;
          say('계정 또는 채팅방이 변경되었습니다. 초안은 유지됩니다. JSON으로 내보낸 뒤 관리 창을 다시 열어 주세요.', 'error');
        } else if (typeof now.revision === 'number' && now.revision !== loaded.state.revision) {
          stale = true;
          say('다른 탭에서 라이브러리가 변경되었습니다. 초안을 유지하고 있습니다. 내보내기 후 다시 열어 충돌을 확인하세요.', 'error');
        } else if (!paneKind) {
          // Reading current state has no storage writes or notification effects.
          render();
        }
      });
      render();
      say(libraryUIStatusText(loaded.status));
      search.focus();
    } catch (error) {
      if (closed) return;
      workspace.classList.add('hidden');
      for (const control of [restoreButton, saveButton, reloadButton]) control.classList.add('hidden');
      say(libraryUIMessage(error), 'error');
    }
  }

  function startLibraryUI() {
    function mount() {
      if (!document.body || libraryMenuStarted) return;
      libraryMenuStarted = true;
      const menus = new Map();
      const popupObservers = new Map();
      let scheduled = null;
      function removeMenu(tablist, menu) {
        menu.control.remove();
        if (tablist.style.overflowX === 'auto') tablist.style.overflowX = menu.overflowX;
        if (tablist.style.scrollbarWidth === 'thin') tablist.style.scrollbarWidth = menu.scrollbarWidth;
        menus.delete(tablist);
      }
      function scan() {
        scheduled = null;
        const anchors = new Map();
        for (const tab of document.querySelectorAll('[role="tab"]')) {
          if (tab.textContent?.trim() !== '단축어 허브') continue;
          const tablist = tab.closest('[role="tablist"]');
          if (tablist && tab.parentElement === tablist) anchors.set(tablist, tab);
        }
        for (const [tablist, menu] of menus) {
          if (!anchors.has(tablist) || !menu.control.isConnected) removeMenu(tablist, menu);
        }
        for (const [tablist, hub] of anchors) {
          let menu = menus.get(tablist);
          if (!menu) {
            const control = libraryUIElement('button', hub.className, '단축어 관리');
            control.type = 'button';
            control.setAttribute('data-crack-library-control', '');
            control.setAttribute('aria-haspopup', 'dialog');
            control.style.flexShrink = '0';
            // This opens a dialog; native Radix tab roles/IDs/selection stay on
            // the original tabs. Their collection must not include this action.
            for (const type of ['pointerdown', 'mousedown', 'keydown']) control.addEventListener(type, event => event.stopPropagation());
            control.addEventListener('click', event => {
              event.preventDefault();
              event.stopPropagation();
              libraryMenuControl = control;
              openLibraryUI(control).catch(error => { try { console.warn('[CrackShortcutLibrary] editor unavailable', libraryUIMessage(error)); } catch { /* No sensitive diagnostics. */ } });
            });
            menu = { control, overflowX: tablist.style.overflowX, scrollbarWidth: tablist.style.scrollbarWidth };
            menus.set(tablist, menu);
            tablist.style.overflowX = 'auto';
            tablist.style.scrollbarWidth = 'thin';
          }
          if (hub.nextElementSibling !== menu.control) hub.after(menu.control);
        }
        libraryMenuControl = [...menus.values()].map(menu => menu.control).find(control => control.isConnected) || null;
        // Watch only the native shortcut popup subtree, never the chat body.
        const popups = new Set(document.querySelectorAll('[data-slash-command-suggestion-popup]'));
        for (const [popup, observer] of popupObservers) {
          if (!popups.has(popup)) { observer.disconnect(); popupObservers.delete(popup); }
        }
        for (const popup of popups) {
          if (popupObservers.has(popup)) continue;
          const observer = new MutationObserver(schedule);
          observer.observe(popup, { childList: true, subtree: true });
          popupObservers.set(popup, observer);
        }
      }
      function schedule() {
        if (scheduled !== null) return;
        scheduled = window.setTimeout(scan, 80);
      }
      new MutationObserver(schedule).observe(document.body, { childList: true });
      document.addEventListener('click', schedule, true);
      window.addEventListener('popstate', schedule);
      window.addEventListener('pageshow', schedule);
      // Covers SPA portals inserted below existing containers and tab text changes.
      window.setInterval(schedule, 1000);
      scan();
    }
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount, { once: true });
  }


  installXHRHook();
  libraryRuntime.start();
  window.addEventListener('storage', event => {
    // v1 data is read only; account changes and cross-tab state use verified v2 storage.
    if (event.key === null) void libraryRuntime.refreshIdentity(true);
  });
  function startUI() {
    if (!document.body) return;
    try { observeShortcutModal(); startLibraryUI(); } catch { warnOnce('ui', 'sorter control unavailable'); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startUI, { once: true });
  else startUI();
})();
