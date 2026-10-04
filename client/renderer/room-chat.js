'use strict';
((root) => {
  const TOPIC = 'quickshare.chat.v1';
  const LIMIT = 200;
  const PERMISSION_ERROR = '当前连接没有聊天权限，请更新服务端 Token 服务后重新进入房间';
  function create(room, events, roomId, onChange = () => {}) {
    const messages = [], seen = new Set(), rates = new Map(), listeners = [];
    let disposed = false, sending = false, lastSent = 0;
    const sessionId = crypto.randomUUID();
    const member = (p, self = false) => ({ id: p.identity, name: p.name || p.identity || '成员', self, host: p.identity?.startsWith('pub-') === true });
    function snapshot() {
      const connected = room.state === 'connected';
      const permissionError = connected && room.localParticipant.permissions?.canPublishData === false ? PERMISSION_ERROR : '';
      return { sessionId, roomId, connected, canSend: connected && !permissionError, permissionError, members: [room.localParticipant, ...room.remoteParticipants.values()].filter(p => p?.identity).map(p => member(p, p === room.localParticipant)), messages: messages.slice() };
    }
    function refresh() { if (!disposed) onChange(snapshot()); }
    function append(packet, participant) {
      const key = `${participant.identity}:${packet.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      messages.push({ key, name: participant.name || participant.identity, text: packet.text, time: Date.now(), self: participant === room.localParticipant });
      if (messages.length > LIMIT) seen.delete(messages.shift().key);
      refresh();
    }
    function receive(payload, participant, _kind, topic) {
      if (disposed || topic !== TOPIC || !participant?.identity || payload.byteLength > 4096) return;
      let packet; try { packet = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
      if (packet?.v !== 1 || typeof packet.id !== 'string' || packet.id.length > 80 || typeof packet.text !== 'string' || !packet.text.trim() || packet.text.length > 500) return;
      const now = Date.now(), recent = (rates.get(participant.identity) || []).filter(t => now - t < 1000);
      if (recent.length >= 5) return;
      recent.push(now); rates.set(participant.identity, recent);
      append(packet, participant); // Sender name comes from the authenticated room participant.
    }
    for (const event of ['Connected','Reconnected','Reconnecting','Disconnected','ParticipantConnected','ParticipantDisconnected','ParticipantNameChanged','ParticipantPermissionsChanged']) {
      if (events[event]) { room.on(events[event], refresh); listeners.push([events[event], refresh]); }
    }
    if (events.ParticipantDisconnected) {
      const departed = p => rates.delete(p.identity);
      room.on(events.ParticipantDisconnected, departed);listeners.push([events.ParticipantDisconnected, departed]);
    }
    room.on(events.DataReceived, receive);listeners.push([events.DataReceived, receive]);
    refresh();
    return {
      snapshot, refresh,
      async send(text) {
        if (disposed || room.state !== 'connected') throw new Error('连接尚未就绪，请稍后发送');
        if (room.localParticipant.permissions?.canPublishData === false) throw new Error(PERMISSION_ERROR);
        text = String(text).trim();
        if (!text || text.length > 500) throw new Error('请输入 1–500 字的消息');
        if (sending || Date.now() - lastSent < 500) throw new Error('发送过快，请稍后重试');
        sending = true;
        const packet = { v: 1, id: crypto.randomUUID(), text };
        try {
          await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(packet)), { reliable: true, topic: TOPIC });
          if (!disposed) { lastSent = Date.now(); append(packet, room.localParticipant); }
        } finally { sending = false; }
      },
      dispose() { disposed = true; for (const [event, fn] of listeners) room.off(event, fn); rates.clear();seen.clear();messages.length=0; },
    };
  }
  function render(container, state) {
    const memberList = container.querySelector('.chat-members');
    memberList.textContent = '';
    for (const member of state.members) {
      const row = document.createElement('div');
      row.textContent = `${member.name}${member.host ? ' · 共享者' : ''}${member.self ? '（我）' : ''}`;
      memberList.appendChild(row);
    }
    container.querySelector('.chat-count').textContent = `成员 ${state.members.length}${state.connected ? '' : ' · 连接已断开/重连中'}`;
    const list = container.querySelector('.chat-messages');
    const previousScroll = list.scrollTop;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 50;
    list.textContent = '';
    for (const message of state.messages) {
      const item = document.createElement('div');item.className = 'chat-message';
      const heading = document.createElement('small');heading.textContent = `${message.name}${message.self ? '（我）' : ''} · ${new Date(message.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
      const body = document.createElement('div');body.textContent = message.text;
      item.appendChild(heading);item.appendChild(body);list.appendChild(item);
    }
    if (!state.messages.length) list.textContent = '暂无消息';
    if (nearBottom) list.scrollTop = list.scrollHeight;
    else list.scrollTop = previousScroll;
    const button = container.querySelector('button[type=submit]');if (button) button.disabled = !(state.canSend ?? state.connected);
    const permission = container.querySelector('.chat-permission');
    if (permission) { permission.textContent = state.permissionError || '';permission.hidden = !state.permissionError; }
  }
  function layout(container, readonly = false) {
    container.classList.add('room-chat');
    container.innerHTML = '<details open><summary class="chat-count">成员</summary><div class="chat-members"></div></details><div class="chat-messages" role="log" aria-live="polite"></div>' + (readonly ? '' : '<div class="chat-permission" role="status" hidden></div><form class="chat-form"><textarea aria-label="聊天消息" maxlength="500" rows="2" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea><button type="submit">发送</button><span class="chat-error" role="status"></span></form>');
  }
  function mount(container, room, events, roomId, onChange) {
    layout(container);
    const model = create(room, events, roomId, state => { render(container,state);onChange?.(state); });
    const form = container.querySelector('form'), input = container.querySelector('textarea'), error = container.querySelector('.chat-error');
    let busy = false;
    form.onsubmit = async event => {
      event.preventDefault();if (busy) return;busy = true;error.textContent = '';
      const value = input.value;
      try { await model.send(value);if (input.value === value) input.value = ''; }
      catch (e) { error.textContent = e.message || '发送失败，请重试'; }
      finally { busy = false; }
    };
    input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault();form.requestSubmit(); } };
    return { ...model, dispose() { model.dispose();form.onsubmit = null;input.onkeydown = null;container.textContent = ''; } };
  }
  const api = { create, mount, layout, render, TOPIC };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QuickShareChat = api;
})(typeof window === 'undefined' ? globalThis : window);
