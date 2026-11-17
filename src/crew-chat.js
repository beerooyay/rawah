// Direct conversations stay in this play session, bounded per companion.
export class CrewChat {
  constructor({ reply, onOpen, onClose }) {
    this.reply = reply; this.onOpen = onOpen; this.onClose = onClose;
    this.actor = null; this.histories = new Map(); this.pending = false;
    this.el = document.createElement('dialog');
    this.el.className = 'crew-chat';
    this.el.setAttribute('aria-labelledby', 'crew-chat-title');
    this.el.innerHTML = `<header><div><small>THE CREW</small><h2 id="crew-chat-title"></h2></div><button type="button" aria-label="End conversation">Back to the trail</button></header><div class="crew-chat-log" role="log" aria-live="polite" aria-label="Conversation"></div><p class="crew-chat-status" role="status"></p><form><label for="crew-chat-input">Say something</label><div><input id="crew-chat-input" maxlength="800" autocomplete="off" placeholder="What's on your mind?" required><button type="submit">Send</button></div></form>`;
    document.body.append(this.el);
    this.log = this.el.querySelector('[role=log]'); this.status = this.el.querySelector('[role=status]');
    this.field = this.el.querySelector('input'); this.send = this.el.querySelector('[type=submit]');
    this.el.querySelector('header button').onclick = () => this.close();
    this.el.addEventListener('cancel', e => { e.preventDefault(); this.close(); });
    this.el.addEventListener('keydown', e => e.stopPropagation());
    this.el.addEventListener('keyup', e => e.stopPropagation());
    this.el.querySelector('form').onsubmit = e => { e.preventDefault(); this.submit(); };
  }
  get open() { return this.el.open; }
  show(actor) {
    if (this.open) return;
    this.actor = actor;
    this.name = actor.name[0].toUpperCase() + actor.name.slice(1);
    if (!this.histories.has(actor.name)) this.histories.set(actor.name, []);
    this.el.querySelector('h2').textContent = this.name;
    this.field.value = ''; this.status.textContent = 'Just you and ' + this.name + '. Escape returns to the trail.';
    this.render(); this.onOpen(actor); this.el.showModal(); this.field.focus();
  }
  close() { if (!this.open) return; this.abort?.abort(); this.generation = (this.generation || 0) + 1; this.pending = false; this.send.disabled = false; this.el.close(); this.onClose(this.actor); this.actor = null; }
  render() {
    this.log.replaceChildren();
    for (const m of this.histories.get(this.actor.name)) {
      const row = document.createElement('p'), label = document.createElement('strong');
      label.textContent = (m.role === 'user' ? 'You' : this.name) + ': ';
      row.append(label, document.createTextNode(m.content)); this.log.append(row);
    }
    this.log.scrollTop = this.log.scrollHeight;
  }
  async submit() {
    const text = this.field.value.trim(); if (!text || this.pending) return;
    const actor = this.actor, history = this.histories.get(actor.name), turn = (this.generation || 0) + 1;
    this.generation = turn; this.pending = true; this.send.disabled = true; this.abort = new AbortController();
    history.push({ role: 'user', content: text }); if (history.length > 16) history.splice(0, history.length - 16);
    this.field.value = ''; this.render(); this.status.textContent = this.name + ' is thinking…';
    try {
      const answer = await this.reply(actor, history.slice(), this.abort.signal);
      if (this.generation !== turn) return;
      history.push({ role: 'assistant', content: answer }); if (history.length > 16) history.splice(0, history.length - 16);
      this.render(); this.status.textContent = '';
    } catch (e) {
      if (this.generation !== turn) return;
      history.pop(); this.render(); this.field.value = text;
      this.status.textContent = e.message || 'Could not connect. Try again.';
    } finally {
      if (this.generation === turn) { this.pending = false; this.send.disabled = false; this.field.focus(); }
    }
  }
}
