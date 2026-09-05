
const appOrigin = window.location.origin;
const state = {
  openApi: null,
  operations: [],
  session: null,
  adminSession: null,
  payoutQuote: null,
  adminPayouts: [],
  selectedAdminPayout: null,
  adminPayoutQuery: {
    status: 'PENDING_ADMIN_APPROVAL',
    sort: 'newest',
    limit: 50,
    cursor: null,
  },
  adminPayoutNextCursor: null,
  adminPayoutCursorHistory: [],
  adminDecisionKeys: new Map(),
};
const chatState = { mode: 'live', members: [], messages: [], conversationId: null, currentMemberId: null, readOnly: true, conversations: [], nextCursor: null, messageCursor: null, pendingMessage: null };

const questIdElement = document.querySelector('#quest-id');
const debugLog = document.querySelector('#debug-log');
const authBadge = document.querySelector('#auth-badge');
const authStatus = document.querySelector('#auth-status');
const sessionOutput = document.querySelector('#session-output');
const financeOutput = document.querySelector('#finance-output');
const questOutput = document.querySelector('#quest-output');
const payoutOutput = document.querySelector('#payout-output');
const adminAuthBadge = document.querySelector('#admin-auth-badge');
const adminAuthStatus = document.querySelector('#admin-auth-status');
const adminEmailInput = document.querySelector('#admin-email');
const adminPasswordInput = document.querySelector('#admin-password');
const adminPayoutWorkspace = document.querySelector('#admin-payout-workspace');
const adminPayoutList = document.querySelector('#admin-payout-list');
const adminPayoutDetail = document.querySelector('#admin-payout-detail');
const adminPayoutOutput = document.querySelector('#admin-payout-output');
const adminPayoutStatusInput = document.querySelector('#admin-payout-status');
const adminPayoutSortInput = document.querySelector('#admin-payout-sort');
const adminPayoutLimitInput = document.querySelector('#admin-payout-limit');
const adminPayoutPageStatus = document.querySelector('#admin-payout-page-status');
const adminPayoutPrevious = document.querySelector('#admin-payout-previous');
const adminPayoutNext = document.querySelector('#admin-payout-next');
const operationList = document.querySelector('#operation-list');
const operationFilter = document.querySelector('#operation-filter');
const chatModeBadge = document.querySelector('#chat-mode-badge');
const chatQuestTitle = document.querySelector('#chat-quest-title');
const chatQuestStatus = document.querySelector('#chat-quest-status');
const chatParticipantCount = document.querySelector('#chat-participant-count');
const chatParticipants = document.querySelector('#chat-participants');
const chatConversationTitle = document.querySelector('#chat-conversation-title');
const chatConnection = document.querySelector('#chat-connection');
const chatReadState = document.querySelector('#chat-read-state');
const chatMessages = document.querySelector('#chat-messages');
const chatComposer = document.querySelector('#chat-composer');
const chatMessageInput = document.querySelector('#chat-message-input');
const chatCharacterCount = document.querySelector('#chat-character-count');
const chatSendButton = document.querySelector('#chat-send');
const chatStatus = document.querySelector('#chat-status');

const renderAdminPaginationControls = () => {
  adminPayoutPrevious.disabled = state.adminPayoutCursorHistory.length === 0;
  adminPayoutNext.disabled = !state.adminPayoutNextCursor;
};

const redactKeys = new Set([
  'accountNumber',
  'account_number',
  'authorization',
  'cookie',
  'password',
  'qrPayload',
  'qrDataUrl',
  'qr_string',
  'routingValue',
  'routing_value',
  'secret',
  'token',
  'x-callback-token',
]);

const redact = (value) => {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      redactKeys.has(key) || key.toLowerCase().includes('password')
        ? '[redacted]'
        : redact(entry),
    ]),
  );
};

const isBahtKey = (key = '') => ['reward', 'questFundingTotal', 'questReward'].includes(key);
const displayKey = (key) => key;
const bahtTextFromSatang = (value) => Number.isInteger(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'THB' }).format(value / 100) : '—';
const bahtToSatang = (value) => {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value).trim())) throw new Error('Enter a Baht amount with up to two decimal places.');
  const [whole, fraction = ''] = String(value).trim().split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Enter a positive amount.');
  return amount;
};
const readBahtInput = (selector) => bahtToSatang(document.querySelector(selector).value);
const formatValue = (value) => typeof value === 'string' ? value : JSON.stringify(redact(value ?? null), null, 2);


const debug = (message, details) => {
  const suffix = details === undefined ? '' : ` ${formatValue(details)}`;
  debugLog.textContent = (debugLog.textContent + `[${new Date().toISOString()}] ${message}${suffix}\n`).slice(-60000);
  debugLog.scrollTop = debugLog.scrollHeight;
};

const setStatus = (element, message, type = 'info') => {
  element.textContent = message;
  element.dataset.type = type;
};

const chatInitials = (displayName) => displayName
  .split(' ')
  .map((part) => part[0])
  .join('')
  .slice(0, 2)
  .toUpperCase();

const chatMemberById = (memberId) => chatState.members.find((member) => member.id === memberId);

const chatTime = (createdAt) => new Date(createdAt).toLocaleTimeString([], {
  hour: 'numeric',
  minute: '2-digit',
});

const renderChatParticipants = () => {
  chatParticipants.replaceChildren();
  chatParticipantCount.textContent = String(chatState.members.length);
  chatState.members.forEach((member) => {
    const participant = document.createElement('button');
    participant.type = 'button';
    participant.className = 'chat-member';
    participant.dataset.active = String(member.id === chatState.currentMemberId);
    participant.dataset.role = member.role;
    participant.disabled = chatState.mode === 'live';
    const avatar = document.createElement('span');
    avatar.className = 'chat-avatar';
    avatar.ariaHidden = 'true';
    avatar.textContent = chatInitials(member.displayName);
    const details = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'chat-member-name';
    name.textContent = member.displayName;
    const role = document.createElement('span');
    role.className = 'chat-member-role';
    role.textContent = member.role;
    details.append(name, role);
    participant.append(avatar, details);
    chatParticipants.append(participant);
  });
};

const renderChatMessages = () => {
  chatMessages.replaceChildren();
  if (chatState.messages.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = chatState.conversationId ? 'No Messages yet.' : 'Select a Work Conversation to load Messages.';
    chatMessages.append(empty);
    return;
  }

  chatState.messages.forEach((message) => {
    const isSystem = message.kind === 'SYSTEM';
    const senderId = message.sender?.id ?? message.senderId;
    const member = chatMemberById(senderId);
    const senderName = message.sender?.displayName ?? member?.displayName ?? 'Former member';
    const messageElement = document.createElement('article');
    messageElement.className = `chat-message${isSystem ? ' chat-message--system' : ''}`;
    messageElement.dataset.mine = String(!isSystem && senderId === chatState.currentMemberId);

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    const sender = document.createElement('span');
    sender.className = 'chat-message-sender';
    sender.textContent = isSystem ? 'KU bot · System Message' : senderName;
    const text = document.createElement('p');
    text.className = 'chat-message-text';
    text.textContent = message.text || (message.attachments?.length ? 'Attachment' : '');
    const time = document.createElement('time');
    time.className = 'chat-message-time';
    time.dateTime = message.createdAt;
    time.textContent = chatTime(message.createdAt);
    bubble.append(sender, text, time);
    messageElement.append(bubble);
    chatMessages.append(messageElement);
  });
  chatMessages.scrollTop = chatMessages.scrollHeight;
};

const setChatStatus = (message, type = 'info') => setStatus(chatStatus, message, type);
const renderChatMode = () => {
  chatModeBadge.textContent = 'Live API';
  chatConversationTitle.textContent = chatState.conversationId ? 'Work Conversation' : 'Select a Work Conversation';
  chatQuestTitle.textContent = chatState.questTitle || 'No Quest selected';
  chatQuestStatus.textContent = chatState.questStatus || 'An Active Assignment opens Work Chat.';
  chatConnection.textContent = chatState.conversationId ? 'Messages from the Server' : 'No Conversation loaded';
  chatReadState.textContent = chatState.readOnly ? 'Read-only' : 'You can send Messages';
  renderChatParticipants();
  renderChatMessages();
  syncChatControls();
};
const syncChatControls = () => {
  chatMessageInput.disabled = !chatState.conversationId || chatState.readOnly;
  chatSendButton.disabled = chatMessageInput.disabled || !chatMessageInput.value.trim();
  document.querySelector('#chat-older').hidden = !chatState.messageCursor;
  document.querySelector('#chat-more-conversations').hidden = !chatState.nextCursor;
};
const updateChatCharacterCount = () => {
  chatCharacterCount.textContent = `${chatMessageInput.value.length} / 1000`;
  syncChatControls();
};
const advanceLiveChatReadCursor = async () => {
  const message = chatState.messages.at(-1);
  if (!message || !chatState.conversationId) return;
  try {
    await jsonRequest(`/api/v1/chat/conversations/${chatState.conversationId}/read`, 'POST', { messageId: message.id });
  } catch (error) { debug('Read Cursor update failed', error.message); }
};
const openConversation = async (id) => {
  const conversation = chatState.conversations.find((item) => item.id === id);
  chatState.conversationId = null;
  chatState.messages = [];
  chatState.members = [];
  chatState.readOnly = true;
  chatState.messageCursor = null;
  chatState.pendingMessage = null;
  renderChatMode();
  if (!conversation) return;
  const prefix = `/api/v1/chat/conversations/${encodeURIComponent(id)}`;
  const [participants, messages] = await Promise.all([request(`${prefix}/participants`), request(`${prefix}/messages?limit=50`)]);
  chatState.conversationId = id;
  chatState.members = participants.data.participants;
  chatState.messages = messages.data.items;
  chatState.messageCursor = messages.data.hasMore ? messages.data.nextCursor : null;
  chatState.currentMemberId = state.session.user.id;
  chatState.questTitle = conversation.quest.title;
  chatState.questStatus = conversation.quest.status;
  chatState.readOnly = conversation.readOnly;
  chatMessageInput.value = '';
  renderChatMode();
  updateChatCharacterCount();
  await advanceLiveChatReadCursor();
  setChatStatus(conversation.readOnly ? 'This Work Conversation is read-only.' : 'Ready. Write a Message below.');
};
const loadLiveWorkConversation = async (more = false) => {
  if (!state.session?.user?.id) throw new Error('Sign in from the Member section to open Work Chat.');
  const cursor = more && chatState.nextCursor ? `&cursor=${encodeURIComponent(chatState.nextCursor)}` : '';
  const response = await request(`/api/v1/chat/conversations?limit=20${cursor}`);
  chatState.conversations = more ? [...chatState.conversations, ...response.data.items] : response.data.items;
  chatState.nextCursor = response.data.nextCursor;
  const select = document.querySelector('#conversation-select');
  const previous = chatState.conversationId;
  select.replaceChildren(new Option('Select a Conversation', ''));
  chatState.conversations.forEach((item) => select.append(new Option(`${item.quest.title}${item.readOnly ? ' · Read-only' : ''}`, item.id)));
  select.value = chatState.conversations.some((item) => item.id === previous) ? previous : '';
  if (chatState.conversations.length === 1) select.value = chatState.conversations[0].id;
  await openConversation(select.value);
  setChatStatus(chatState.conversations.length ? 'Select a Conversation. Refresh to load new Messages.' : 'No Work Conversations yet. A Hirer must accept a Worker first. Open Quests to continue.');
};
const loadOlderMessages = async () => {
  if (!chatState.messageCursor) return;
  const result = await request(`/api/v1/chat/conversations/${chatState.conversationId}/messages?limit=50&before=${encodeURIComponent(chatState.messageCursor)}`);
  const ids = new Set(chatState.messages.map((message) => message.id));
  chatState.messages = [...result.data.items.filter((message) => !ids.has(message.id)), ...chatState.messages];
  chatState.messageCursor = result.data.hasMore ? result.data.nextCursor : null;
  const oldHeight = chatMessages.scrollHeight;
  renderChatMessages();
  chatMessages.scrollTop = chatMessages.scrollHeight - oldHeight;
  syncChatControls();
};
const sendChatMessage = async () => {
  const text = chatMessageInput.value.trim();
  if (!text || !chatState.conversationId || chatState.readOnly) throw new Error('Select a writable Conversation and enter a Message.');
  if (!chatState.pendingMessage || chatState.pendingMessage.text !== text) chatState.pendingMessage = { clientMessageId: randomKey('bench-chat'), text };
  const response = await jsonRequest(`/api/v1/chat/conversations/${chatState.conversationId}/messages`, 'POST', chatState.pendingMessage);
  const message = response.data.message;
  if (!chatState.messages.some((item) => item.id === message.id)) chatState.messages.push(message);
  chatState.pendingMessage = null;
  chatMessageInput.value = '';
  renderChatMessages();
  updateChatCharacterCount();
  setChatStatus('Message sent.', 'success');
  await advanceLiveChatReadCursor();
};


const renderWallet = (wallet, email = state.session?.user?.email) => {
  const values = {
    '#wallet-spending': wallet?.spendingBalanceSatang,
    '#wallet-earnings': wallet?.earningsBalanceSatang,
    '#wallet-funding': wallet?.fundingReservedSatang,
    '#wallet-payout': wallet?.reservedForPayoutsSatang,
  };
  Object.entries(values).forEach(([selector, value]) => {
    document.querySelector(selector).textContent = bahtTextFromSatang(value);
  });
  document.querySelector('#wallet-member').textContent = email ? `Member: ${email}` : 'No Wallet loaded.';
};

const refreshWallet = async () => {
  if (!state.session) {
    renderWallet(null, null);
    setStatus(document.querySelector('#wallet-status'), 'Sign in to read the Wallet.', 'info');
    return null;
  }
  try {
    const response = await request('/api/v1/wallet', {}, 'Read current Wallet');
    renderWallet(response?.data?.wallet);
    setStatus(document.querySelector('#wallet-status'), 'Wallet projection is current.', 'success');
    return response;
  } catch (error) {
    renderWallet(null);
    setStatus(document.querySelector('#wallet-status'), error instanceof Error ? error.message : 'Wallet read failed', 'error');
    return null;
  }
};

const parseResponse = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const request = async (path, options = {}, label = `${options.method ?? 'GET'} ${path}`) => {
  const url = new URL(path, appOrigin).toString();
  const requestDetails = {
    method: options.method ?? 'GET',
    url,
    body: options.body && typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
  };
  debug(`${label} →`, requestDetails);

  let response;
  try {
    response = await fetch(url, { ...options, credentials: 'include', signal: AbortSignal.timeout(20000) });
  } catch (error) {
    debug(`${label} network error`, error instanceof Error ? error.message : error);
    throw new Error('The Server did not respond. Check your connection, then retry. Your input is saved.', { cause: error });
  }

  const body = await parseResponse(response);
  debug(`${label} ← ${response.status}`, body);
  if (!response.ok || body?.success === false) {
    const message = response.status === 401 ? 'Your Session ended. Sign in from the Member section, then retry.' : body?.error?.message ?? body?.message ?? `Request failed (${response.status}). Check Request details.`;
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
};

const jsonRequest = (path, method, body, label, headers = {}) => request(path, {
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
}, label);

const randomKey = (prefix) => `${prefix}:${crypto.randomUUID()}`;

const refreshSession = async () => {
  try {
    const data = await request('/api/auth/get-session', {}, 'Refresh Session');
    if (state.session?.user?.id !== data?.user?.id) clearMemberData();
    state.session = data?.user?.id ? data : null;
    sessionOutput.textContent = formatValue(data ?? null);
    const signedIn = Boolean(data?.user?.id);
    authBadge.textContent = signedIn ? 'signed in' : 'signed out';
    authBadge.dataset.state = signedIn ? 'success' : 'pending';
    setStatus(authStatus, signedIn ? `Signed in as ${data.user.email}` : 'No Session', signedIn ? 'success' : 'info');
    updateMember();
    return state.session;
  } catch (error) {
    clearMemberData();
    state.session = null;
    updateMember();
    sessionOutput.textContent = 'null';
    authBadge.textContent = 'error';
    authBadge.dataset.state = 'error';
    setStatus(authStatus, error instanceof Error ? error.message : 'Session check failed', 'error');
    return null;
  }
};

const switchTestAccountSession = async (accountKey) => {
  await jsonRequest(`/api/staging/test-auth/sign-in/${accountKey}`, 'POST', {}, 'Test Member sign-in');
  const session = await refreshSession();
  if (!session) throw new Error('No Member Session returned. Use Google sign-in if test sign-in is disabled.');
  await Promise.all([loadTags(), refreshWallet()]);
  return { message: 'Member ready. Open Quests or Work Chat.' };
};
const signInWithGoogle = async () => {
  const data = await jsonRequest('/api/auth/sign-in/social', 'POST', {
    provider: 'google', callbackURL: `${appOrigin}/#member`, errorCallbackURL: `${appOrigin}/#member`, disableRedirect: true,
  }, 'Google sign-in');
  if (!data?.url) throw new Error('No Google sign-in URL returned.');
  window.location.assign(data.url);
};
const signOut = async () => {
  await jsonRequest('/api/auth/sign-out', 'POST', {}, 'Sign out');
  clearMemberData();
  state.session = null;
  await refreshSession();
};


const loadTags = async () => {
  if (!state.session) return;
  try {
    const response = await request('/api/v1/tags', {}, 'List Tags');
    const tags = response?.data ?? [];
    const select = document.querySelector('#quest-tag');
    select.replaceChildren(new Option('Select a Tag', ''));
    tags.forEach((tag) => select.append(new Option(`${tag.name} (${tag.id})`, tag.id)));
  } catch (error) {
    debug('Tag loading skipped', error instanceof Error ? error.message : error);
  }
};

const renderPaymentResult = (response) => {
  financeOutput.textContent = formatValue(response);
  const qrDataUrl = response?.data?.topUp?.qrDataUrl;
  const panel = document.querySelector('#payment-qr-panel');
  const image = document.querySelector('#payment-qr');
  if (qrDataUrl) {
    image.src = qrDataUrl;
    panel.hidden = false;
    document.querySelector('#payment-qr-status').textContent = response.data.topUp.topUpStatus === 'PAID'
      ? 'This Payment Request is already paid in Test Mode. The QR came from the Xendit response.'
      : 'Scan this QR with the Xendit Test Mode payment flow.';
  } else {
    image.removeAttribute('src');
    panel.hidden = true;
  }
  // Local finance tests can use a different Member; keep the Session Wallet separate.
};

const selectedQuestId = () => questIdElement.value.trim();
const requireQuestId = () => {
  if (!selectedQuestId()) throw new Error('Select a Quest or enter its ID first.');
  return selectedQuestId();
};
const questBody = () => {
  const startTime = `${document.querySelector('#quest-start').value}:00+07:00`;
  const dueAt = `${document.querySelector('#quest-due').value}:00+07:00`;
  if (new Date(dueAt) <= new Date(startTime)) throw new Error('Due time must be after Start time.');
  const items = document.querySelector('#quest-condition').value.split('\n').map((item) => item.trim()).filter(Boolean);
  if (!items.length || items.some((item) => item.length > 255)) throw new Error('Enter at least one Condition Item. Use up to 255 characters per line.');
  return {
    title: document.querySelector('#quest-title').value.trim(),
    condition: { items },
    mode: document.querySelector('#quest-mode').value,
    participation: document.querySelector('#quest-participation').value,
    questFundingTotal: readBahtInput('#quest-reward') / 100,
    headcount: Number(document.querySelector('#quest-headcount').value),
    startTime, dueAt,
    tagId: document.querySelector('#quest-tag').value || null,
    proofRequired: document.querySelector('#quest-proof-required').checked,
  };
};
const showQuest = (response) => {
  questOutput.textContent = formatValue(response);
  const quest = response?.data?.quest ?? response?.data;
  if (quest?.id && quest?.state) {
    state.quest = quest;
    questIdElement.value = quest.id;
    state.publishCheck = null;
    const summary = document.querySelector('#quest-summary');
    summary.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = quest.title;
    const context = document.createElement('p');
    context.textContent = `${quest.state} · ${quest.mode} · ${quest.participation} · ${quest.proofRequired ? 'Proof required' : 'Proof not required'}`;
    const next = document.createElement('p');
    next.textContent = quest.state === 'QUEST_DRAFT' ? 'Next: Check publication. The Server will show any missing information or funding.' : quest.state === 'QUEST_OPEN' ? 'Next: Use a second Member to join or apply. Advanced actions are in the API explorer.' : ['QUEST_COMPLETED', 'QUEST_CANCELLED', 'QUEST_FAILED'].includes(quest.state) ? 'This Quest is Terminal. Work Chat is read-only.' : 'Next: Use the API explorer for Start Work, Proof Submission, or review. The Server checks your actor and Quest State.';
    const deadline = document.createElement('p'); deadline.id = 'quest-deadline';
    deadline.textContent = quest.dueAt ? `Due: ${new Date(quest.dueAt).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' })} (Asia/Bangkok)` : 'No Due time set.';
    const link = document.createElement('a'); link.href = '#explorer'; link.textContent = 'Open actions in API explorer →';
    summary.append(title, context, deadline, next, link);
  }
  syncControls();
  return response;
};
const getDetail = async () => showQuest(await request(`/api/v2/quests/${encodeURIComponent(requireQuestId())}`));
let questCreateAttempt;
const createQuest = async () => {
  const body = questBody();
  const signature = `${state.session?.user?.id}:${JSON.stringify(body)}`;
  if (!questCreateAttempt || questCreateAttempt.signature !== signature) {
    questCreateAttempt = { signature, key: randomKey('create-quest') };
  }
  const response = await jsonRequest(
    '/api/v2/quests',
    'POST',
    body,
    'Create Draft Quest',
    { 'idempotency-key': questCreateAttempt.key },
  );
  questCreateAttempt = null;
  showQuest(response);
  setStatus(document.querySelector('#quest-flow-status'), 'Draft saved. Check publication before you reserve Quest Escrow.', 'success');
  document.querySelector('.selected-quest').scrollIntoView({ block: 'start' });
  return response;
};
const publishCheck = async () => {
  const response = await request(`/api/v2/quests/${encodeURIComponent(requireQuestId())}/publish-check`);
  state.publishCheck = response.data;
  const reasons = response.data.blockingReasons.map((reason) => reason.message ?? reason.code).join(' ');
  setStatus(document.querySelector('#quest-flow-status'), response.data.canPublish ? `Ready to publish. Quest Escrow: ${bahtTextFromSatang(response.data.escrowRequirementSatang)}.` : `Publication blocked: ${reasons} Use the API explorer to edit this Draft, or add funds in Wallet.`, response.data.canPublish ? 'success' : 'error');
  return response;
};
const publishQuest = async () => {
  if (!state.publishCheck?.canPublish) throw new Error('Check publication and resolve its blockers first.');
  const response = await request(`/api/v2/quests/${encodeURIComponent(requireQuestId())}/publish`, { method: 'POST', headers: { 'idempotency-key': commandKey('publish') } });
  showQuest(response);
  await refreshWallet();
  return response;
};
const cancelQuest = async () => {
  const response = await request(`/api/v2/quests/${encodeURIComponent(requireQuestId())}/cancel`, { method: 'POST', headers: { 'idempotency-key': commandKey('cancel') } });
  await getDetail();
  await refreshWallet();
  return response;
};
const commandKeys = new Map();
const commandKey = (action) => {
  const key = `${state.session?.user?.id}:${selectedQuestId()}:${action}`;
  if (!commandKeys.has(key)) commandKeys.set(key, randomKey(action));
  return commandKeys.get(key);
};
const listQuests = async (mine) => {
  const response = await request(`/api/v2/quests${mine ? '/mine' : ''}?limit=50`);
  const container = document.querySelector('#quest-cards');
  container.replaceChildren();
  const items = response.data.items;
  if (!items.length) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = mine ? 'No Quests yet. Create your first Draft above.' : 'No available Quests. Use another Member to publish a Quest first.';
    container.append(empty);
  }
  items.forEach((quest) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'quest-card';
    const title = document.createElement('strong'); title.textContent = quest.title;
    const status = document.createElement('small'); status.textContent = `${quest.state} · ${quest.mode} · ${quest.participation}`;
    button.append(title, status);
    button.addEventListener('click', () => runWithOutput(questOutput, async () => {
      questIdElement.value = quest.id;
      state.quest = null; state.publishCheck = null;
      return showQuest(await request(`/api/v2/quests/${encodeURIComponent(quest.id)}${mine ? '' : '/public'}`));
    }));
    container.append(button);
  });
  if (response.data.nextCursor) {
    const note = document.createElement('p'); note.className = 'muted'; note.textContent = 'Showing the first 50 Quests. Use the API explorer cursor to load more.'; container.append(note);
  }
  return response;
};
const listMine = () => listQuests(true);
const listBoard = () => listQuests(false);


const schemaFromRef = (schema) => {
  if (!schema || !schema.$ref) return schema;
  const name = schema.$ref.split('/').pop();
  return state.openApi?.components?.schemas?.[name] ?? schema;
};

const exampleForSchema = (schema, propertyName = '') => {
  const resolved = schemaFromRef(schema) ?? {};
  if (resolved.const !== undefined) return resolved.const;
  if (resolved.example !== undefined) return resolved.example;
  if (resolved.enum?.length) return resolved.enum[0];
  if (resolved.oneOf?.length) return exampleForSchema(resolved.oneOf[0], propertyName);
  if (resolved.anyOf?.length) return exampleForSchema(resolved.anyOf[0], propertyName);
  if (resolved.allOf?.length) {
    return resolved.allOf.reduce((value, item) => ({ ...value, ...exampleForSchema(item, propertyName) }), {});
  }
  if (resolved.type === 'object' || resolved.properties) {
    return Object.fromEntries(Object.entries(resolved.properties ?? {}).map(([name, child]) => [name, exampleForSchema(child, name)]));
  }
  if (resolved.type === 'array') return [];
  if (resolved.type === 'integer' || resolved.type === 'number') {
    if (propertyName.toLowerCase().includes('rating')) return 5;
    if (propertyName.toLowerCase().includes('headcount')) return 1;
    if (propertyName.toLowerCase().includes('rework')) return 0;
    return 100;
  }
  if (resolved.type === 'boolean') return true;
  if (resolved.format === 'date-time') return new Date(Date.now() + 480 * 60_000).toISOString().replace('Z', '+07:00');
  if (resolved.format === 'uuid') return propertyName.toLowerCase().includes('quest') ? selectedQuestId() : '';
  if (propertyName.toLowerCase().includes('content')) return 'Browser test proof content';
  if (propertyName.toLowerCase().includes('title')) return 'Browser test Quest';
  if (propertyName.toLowerCase().includes('condition')) return 'Complete the browser test condition';
  if (propertyName.toLowerCase().includes('name')) return 'Browser test';
  return '';
};

const operationBodySchema = (operation) => {
  const content = operation.requestBody?.content ?? {};
  const multipart = schemaFromRef(content['multipart/form-data']?.schema);
  const hasFiles = Object.values(multipart?.properties ?? {}).some((property) => property.format === 'binary' || property.items?.format === 'binary');
  const mediaType = hasFiles ? 'multipart/form-data' : content['application/json'] ? 'application/json' : Object.keys(content)[0];
  return mediaType ? { mediaType, schema: content[mediaType].schema } : null;
};

const isMoneyParameter = () => false;
const toApiMoneyValue = (value) => value;
const operationExample = (operation) => {
  const body = operationBodySchema(operation);
  return body ? JSON.stringify(exampleForSchema(body.schema), null, 2) : '';
};


const parameterInput = (parameter) => {
  const input = document.createElement('input');
  input.name = parameter.name;
  input.dataset.parameter = parameter.in;
  input.dataset.money = String(isMoneyParameter(parameter.name));
  input.placeholder = parameter.required ? 'required' : 'optional';
  input.value = parameter.in === 'path' && parameter.name === 'questId' ? selectedQuestId() : '';
  if (parameter.in === 'header' && parameter.name.toLowerCase() === 'idempotency-key') input.value = randomKey('browser');
  input.required = Boolean(parameter.required);
  if (parameter.schema?.format === 'date-time') input.placeholder = '2026-09-05T10:00:00+07:00';
  if (isMoneyParameter(parameter.name)) {
    input.type = 'number';
    input.min = '0.01';
    input.step = '0.01';
  }
  return input;
};

const buildOperationCard = ({ path, method, operation }) => {
  const details = document.createElement('details');
  details.className = 'operation';
  details.dataset.tags = (operation.tags ?? []).join('|');
  const summary = document.createElement('summary');
  const methodBadge = document.createElement('span');
  methodBadge.className = 'method';
  methodBadge.dataset.method = method;
  methodBadge.textContent = method;
  const pathText = document.createElement('span');
  pathText.className = 'operation-path';
  pathText.textContent = operation.summary ? `${operation.summary} — ${path}` : path;
  summary.append(methodBadge, pathText);
  if (path.startsWith('/api/v1/quests')) {
    const legacy = document.createElement('span'); legacy.className = 'badge'; legacy.textContent = 'Legacy Implementation'; summary.append(legacy);
  }

  const body = document.createElement('div');
  body.className = 'operation-body';
  const form = document.createElement('form');
  const parameters = operation.parameters ?? [];
  const parameterFields = document.createElement('div');
  parameterFields.className = 'operation-fields';
  parameters.forEach((parameter) => {
    const label = document.createElement('label');
    const parameterName = isMoneyParameter(parameter.name) ? displayKey(parameter.name) : isBahtKey(parameter.name) ? `${parameter.name} (Baht)` : parameter.name;
    label.textContent = `${parameter.in}: ${parameterName}${parameter.required ? ' *' : ''}`;
    label.append(parameterInput(parameter));
    parameterFields.append(label);
  });
  if (parameterFields.children.length) form.append(parameterFields);

  const requestBody = operationBodySchema(operation);
  let bodyInput;
  const fileInputs = [];
  if (requestBody) {
    const label = document.createElement('label');
    label.className = 'wide';
    label.textContent = `Request fields (${requestBody.mediaType})`;
    bodyInput = document.createElement('textarea');
    bodyInput.dataset.requestBody = requestBody.mediaType;
    bodyInput.value = operationExample(operation);
    label.append(bodyInput);
    form.append(label);
    if (requestBody.mediaType.includes('multipart')) {
      const properties = schemaFromRef(requestBody.schema)?.properties ?? {};
      Object.entries(properties).forEach(([name, property]) => {
        const field = schemaFromRef(property);
        if (field?.format !== 'binary' && field?.items?.format !== 'binary') return;
        const fileLabel = document.createElement('label');
        fileLabel.textContent = `File: ${name}`;
        const input = document.createElement('input');
        input.type = 'file'; input.name = name; input.multiple = field.type === 'array';
        fileInputs.push(input); fileLabel.append(input); form.append(fileLabel);
      });
    }
  }

  const send = document.createElement('button');
  send.className = 'primary';
  send.type = 'submit';
  send.textContent = `Send ${method}`;
  form.append(send);
  const result = document.createElement('pre');
  result.className = 'small-pre';
  result.textContent = 'No request yet.';
  form.append(result);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    send.disabled = true;
    try {
      let requestPath = path;
      const query = new URLSearchParams();
      const headers = {};
      form.querySelectorAll('[data-parameter]').forEach((input) => {
        const value = input.value.trim();
        if (!value) return;
        if (input.dataset.parameter === 'path') requestPath = requestPath.replace(`{${input.name}}`, encodeURIComponent(value));
        if (input.dataset.parameter === 'query') {
          query.set(input.name, input.dataset.money === 'true' ? String(bahtToSatang(value)) : value);
        }
        if (input.dataset.parameter === 'header') headers[input.name] = value;
      });
      if (["POST", "PATCH", "PUT"].includes(method) && operation.parameters?.some((parameter) => parameter.in === 'header' && parameter.name.toLowerCase() === 'idempotency-key') && !headers['idempotency-key']) {
        headers['idempotency-key'] = randomKey('browser');
      }
      if (requestPath.includes('{')) throw new Error('Fill all path fields before sending.');
      if (query.size) requestPath += `?${query.toString()}`;

      const options = { method, headers };
      if (bodyInput && requestBody.mediaType.includes('multipart')) {
        const formData = new FormData();
        const fields = bodyInput.value.trim() ? toApiMoneyValue(JSON.parse(bodyInput.value)) : {};
        Object.entries(fields).forEach(([name, value]) => {
          if (fileInputs.some((input) => input.name === name)) return;
          if (Array.isArray(value)) value.forEach((entry) => formData.append(name, String(entry)));
          else if (value !== undefined && value !== null) formData.append(name, String(value));
        });
        fileInputs.forEach((input) => Array.from(input.files ?? []).forEach((file) => formData.append(input.name, file)));
        options.body = formData;
      } else if (bodyInput && bodyInput.value.trim() && !['GET', 'DELETE'].includes(method)) {
        options.headers = { ...headers, 'content-type': 'application/json' };
        options.body = JSON.stringify(toApiMoneyValue(JSON.parse(bodyInput.value)));
      }
      const response = await request(requestPath, options, `${operation.operationId ?? method} ${requestPath}`);
      result.textContent = formatValue(response);
    } catch (error) {
      result.textContent = formatValue(error?.body ?? { error: error instanceof Error ? error.message : String(error) });
    } finally {
      send.disabled = false;
    }
  });

  body.append(form);
  details.append(summary, body);
  return details;
};

const renderOperations = () => {
  const filter = operationFilter.value;
  const search = document.querySelector('#operation-search').value.toLowerCase();
  operationList.replaceChildren();
  const operations = state.operations.filter(({ path, operation }) => `${path} ${operation.summary ?? ''}`.toLowerCase().includes(search)).filter(({ operation }) => filter === 'all' || (operation.tags ?? []).includes(filter));
  if (!operations.length) {
    operationList.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'No operations match this filter.' }));
    return;
  }
  operations.forEach((operation) => operationList.append(buildOperationCard(operation)));
};

const loadOperations = async () => {
  try {
    state.openApi = await request('/openapi/json', {}, 'Load OpenAPI operation list');
    state.operations = Object.entries(state.openApi.paths ?? {}).flatMap(([path, pathItem]) => Object.entries(pathItem)
      .filter(([method]) => ['get', 'post', 'patch', 'put', 'delete'].includes(method))
      .map(([method, operation]) => ({ path, method: method.toUpperCase(), operation }))
      .filter((item) => item.path.startsWith('/api/v1/') || item.path.startsWith('/api/v2/')));
    const tags = [...new Set(state.operations.flatMap(({ operation }) => operation.tags ?? []))].sort();
    operationFilter.replaceChildren(new Option('All API operations', 'all'));
    tags.forEach((tag) => operationFilter.append(new Option(tag, tag)));
    document.querySelector('#operation-count').textContent = `${state.operations.length} operations`;
    renderOperations();
  } catch (error) {
    document.querySelector('#operation-count').textContent = 'error';
    operationList.replaceChildren(Object.assign(document.createElement('p'), { className: 'status', textContent: error instanceof Error ? error.message : 'OpenAPI loading failed' }));
  }
};

const runWithOutput = async (output, action, onSuccess = null) => {
  const scope = output.closest('.card');
  if (scope.dataset.busy === 'true') return;
  if (document.querySelector('[aria-labelledby=auth-heading]').dataset.busy === 'true' && scope !== sessionOutput.closest('.card')) { announce('Wait for the Member change to finish.', 'error'); return; }
  const controls = [...scope.querySelectorAll('button, input, select, textarea')];
  const disabled = controls.map((control) => control.disabled);
  scope.dataset.busy = 'true';
  scope.setAttribute('aria-busy', 'true');
  controls.forEach((control) => { control.disabled = true; });
  syncControls();
  announce('Working…');
  try {
    const value = await action();
    if (onSuccess) onSuccess(value);
    else if (value !== undefined) output.textContent = formatValue(value);
    announce('Done. You can continue.', 'success');
  } catch (error) {
    output.textContent = formatValue(error?.body ?? { error: error.message });
    if (output.closest('details')) output.closest('details').open = true;
    announce(error.message, 'error');
    debug('Action failed', error.message);
  } finally {
    scope.dataset.busy = 'false';
    scope.removeAttribute('aria-busy');
    controls.forEach((control, i) => { control.disabled = disabled[i]; });
    renderAdminPaginationControls();
    syncControls();
  }
};


const quotePayout = async () => {
  state.payoutQuote = null;
  const response = await jsonRequest('/api/v1/payouts/quotes', 'POST', {
    receiptSatang: readBahtInput('#payout-amount'),
  }, 'Quote Payout');
  state.payoutQuote = response?.data ?? null;
  state.payoutQuoteAmount = document.querySelector('#payout-amount').value;
  state.payoutQuoteKey = randomKey('browser-payout');
  payoutOutput.textContent = formatValue(response);
  const quote = state.payoutQuote;
  document.querySelector('#payout-destination').textContent = quote?.payoutDestinationId
    ? `Destination ready · quote ${quote.id.slice(0, 8)}…`
    : 'Shown after quote';
  setStatus(document.querySelector('#payout-status'), quote
    ? `Quote ready. Maximum debit: ${bahtTextFromSatang(quote.maximumDebitSatang)}.`
    : 'No Payout Quote returned.', 'success');
  return response;
};

const submitPayout = async () => {
  if (!validPayoutQuote()) throw new Error('Get a new Payout Quote before submitting.');
  const response = await jsonRequest('/api/v1/payouts', 'POST', {
    quoteId: state.payoutQuote.id,
  }, 'Submit Payout for Admin approval', { 'idempotency-key': state.payoutQuoteKey });
  payoutOutput.textContent = formatValue(response);
  setStatus(document.querySelector('#payout-status'), `Payout status: ${response?.data?.payoutStatus ?? 'submitted'}. Provider hand-off waits for Admin approval.`, 'success');
  state.payoutQuote = null;
  await refreshWallet();
  return response;
};

const listPayouts = async () => {
  const response = await request('/api/v1/payouts?limit=10', {}, 'List Payouts');
  payoutOutput.textContent = formatValue(response);
  return response;
};

const adminPayoutIsWaiting = (payout) => payout?.payoutStatus === 'PENDING_ADMIN_APPROVAL';

const adminPayoutStudentName = (payout) => [payout?.student?.firstName, payout?.student?.lastName]
  .filter(Boolean)
  .join(' ');

const adminPayoutStatusType = (payoutStatus) => {
  if (['FAILED', 'CANCELLED'].includes(payoutStatus)) return 'error';
  if (payoutStatus === 'COMPLETED') return 'success';
  return 'info';
};

const requireSelectedAdminWaitingPayout = () => {
  const payout = state.selectedAdminPayout;
  if (!payout || !adminPayoutIsWaiting(payout)) throw new Error('Select a Payout waiting for Admin approval.');
  return payout;
};

const adminDecisionIdempotencyKey = (action, payoutId, body) => {
  const storageKey = `${action}:${payoutId}`;
  const requestSignature = JSON.stringify(body);
  const existing = state.adminDecisionKeys.get(storageKey);
  if (!existing || existing.requestSignature !== requestSignature) {
    const decision = { requestSignature, key: randomKey(`browser-admin-${action.toLowerCase()}`) };
    state.adminDecisionKeys.set(storageKey, decision);
    return decision.key;
  }
  return existing.key;
};

const resetAdminPayoutQuery = () => {
  state.adminPayoutQuery = {
    status: adminPayoutStatusInput.value,
    sort: adminPayoutSortInput.value,
    limit: Number(adminPayoutLimitInput.value),
    cursor: null,
  };
  state.adminPayoutCursorHistory = [];
  state.adminPayoutNextCursor = null;
  state.selectedAdminPayout = null;
};



const renderAdminAuth = () => {
  const signedIn = Boolean(state.adminSession?.user);
  adminAuthBadge.textContent = signedIn
    ? `Admin: ${state.adminSession.user.email}`
    : 'Admin sign-in required';
  adminAuthBadge.dataset.state = signedIn ? 'success' : 'pending';
  adminPayoutWorkspace.hidden = !signedIn;
  if (!signedIn) {
    state.adminPayouts = [];
    state.selectedAdminPayout = null;
    state.adminPayoutNextCursor = null;
    state.adminPayoutCursorHistory = [];
    setStatus(adminAuthStatus, 'Use an Admin account to open the approval queue.', 'info');
    adminPayoutList.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: 'Sign in as Admin to load Payouts.',
    }));
    adminPayoutDetail.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: 'Select a Payout to review it.',
    }));
    renderAdminPaginationControls();
    setStatus(adminPayoutPageStatus, 'Sign in as Admin to load Payouts.', 'info');
  } else {
    setStatus(adminAuthStatus, `Signed in as Admin ${state.adminSession.user.email}.`, 'success');
  }
};

const createAdminFact = (label, value) => {
  const row = document.createElement('div');
  const name = document.createElement('dt');
  const content = document.createElement('dd');
  name.textContent = label;
  content.textContent = value ?? '—';
  row.append(name, content);
  return row;
};

const renderAdminPayoutList = () => {
  adminPayoutList.replaceChildren();
  if (!state.adminPayouts.length) {
    adminPayoutList.append(Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: 'No Payout is waiting for Admin approval.',
    }));
    return;
  }
  state.adminPayouts.forEach((payout) => {
    const button = document.createElement('button');
    button.className = 'admin-payout-row';
    button.type = 'button';
    button.setAttribute('aria-selected', String(state.selectedAdminPayout?.id === payout.id));
    const title = document.createElement('strong');
    const summary = document.createElement('small');
    title.textContent = adminPayoutStudentName(payout) || payout.student?.email || 'Student Payout';
    summary.textContent = `${bahtTextFromSatang(payout.principalSatang)} · ${payout.payoutStatus}`;
    button.append(title, summary);
    button.addEventListener('click', () => void selectAdminPayout(payout));
    adminPayoutList.append(button);
  });
};

const renderAdminPayoutDetail = () => {
  adminPayoutDetail.replaceChildren();
  const payout = state.selectedAdminPayout;
  if (!payout) {
    adminPayoutDetail.append(Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: 'Select a Payout to review it.',
    }));
    return;
  }

  const heading = document.createElement('div');
  const title = document.createElement('h3');
  const status = document.createElement('span');
  title.textContent = adminPayoutStudentName(payout) || payout.student?.email || 'Student Payout';
  status.className = 'status';
  status.dataset.type = adminPayoutStatusType(payout.payoutStatus);
  status.textContent = payout.payoutStatus;
  heading.className = 'result-heading';
  heading.append(title, status);

  const facts = document.createElement('dl');
  facts.className = 'facts';
  facts.append(
    createAdminFact('Student', payout.student?.email),
    createAdminFact('Receipt amount', bahtTextFromSatang(payout.receiptSatang)),
    createAdminFact('Maximum debit', bahtTextFromSatang(payout.maximumDebitSatang)),
    createAdminFact('Provider fee', bahtTextFromSatang(payout.maximumFeeSatang)),
    createAdminFact('Provider tax', bahtTextFromSatang(payout.maximumTaxSatang)),
    createAdminFact('Destination', `${payout.bankName} · ${payout.maskedDestinationValue}`),
    createAdminFact('Destination type', payout.destinationType),
    createAdminFact('Routing', payout.maskedRoutingValue),
    createAdminFact('Provider status', payout.providerStatus),
    createAdminFact('Provider reference', payout.providerReference),
    createAdminFact('Created', payout.createdAt ? new Date(payout.createdAt).toLocaleString() : null),
  );
  adminPayoutDetail.append(heading, facts);

  if (payout.history?.length) {
    const historyHeading = document.createElement('h4');
    historyHeading.textContent = 'Status history';
    const history = document.createElement('ol');
    history.className = 'admin-history';
    payout.history.forEach((entry) => {
      const item = document.createElement('li');
      const transition = `${entry.fromStatus ?? 'NEW'} → ${entry.toStatus}`;
      const reason = entry.reason ? ` · ${entry.reason}` : '';
      item.textContent = `${new Date(entry.occurredAt).toLocaleString()} · ${transition} · ${entry.source}${reason}`;
      history.append(item);
    });
    adminPayoutDetail.append(historyHeading, history);
  }

  if (!adminPayoutIsWaiting(payout)) {
    if (payout.rejectionReason) adminPayoutDetail.append(createAdminFact('Rejection reason', payout.rejectionReason));
    return;
  }

  const note = document.createElement('label');
  const noteInput = document.createElement('input');
  note.textContent = 'Approval note (optional)';
  noteInput.id = 'admin-approval-note';
  noteInput.maxLength = 500;
  noteInput.placeholder = 'Reviewed amount and destination';
  note.append(noteInput);

  const reason = document.createElement('label');
  const reasonInput = document.createElement('textarea');
  reason.textContent = 'Rejection reason (required only for Reject)';
  reasonInput.id = 'admin-rejection-reason';
  reasonInput.maxLength = 500;
  reasonInput.placeholder = 'Explain why this Payout is rejected';
  reason.append(reasonInput);

  const actions = document.createElement('div');
  actions.className = 'admin-actions';
  const approve = document.createElement('button');
  approve.className = 'primary';
  approve.type = 'button';
  approve.textContent = 'Approve Payout';
  approve.addEventListener('click', () => runWithOutput(adminPayoutOutput, approveSelectedAdminPayout));
  const reject = document.createElement('button');
  reject.className = 'danger';
  reject.type = 'button';
  reject.textContent = 'Reject Payout';
  reject.addEventListener('click', () => runWithOutput(adminPayoutOutput, rejectSelectedAdminPayout));
  actions.append(approve, reject);
  adminPayoutDetail.append(note, reason, actions);
};

const loadAdminPayoutDetail = async (payoutId) => {
  const response = await request(
    `/api/v1/admin/payouts/${encodeURIComponent(payoutId)}`,
    {},
    'Get Admin Payout detail',
  );
  if (state.selectedAdminPayout?.id === payoutId) {
    state.selectedAdminPayout = response?.data ?? state.selectedAdminPayout;
    renderAdminPayoutDetail();
  }
  return response;
};

const selectAdminPayout = async (payout) => {
  state.selectedAdminPayout = payout;
  renderAdminPayoutList();
  renderAdminPayoutDetail();
  try {
    return await loadAdminPayoutDetail(payout.id);
  } catch (error) {
    adminPayoutOutput.textContent = formatValue(error?.body ?? { error: error instanceof Error ? error.message : String(error) });
    debug('Admin Payout detail loading failed', error instanceof Error ? error.message : error);
    return null;
  }
};

const loadAdminPayouts = async ({ reset = false } = {}) => {
  if (!state.adminSession) return null;
  if (reset) resetAdminPayoutQuery();
  const query = new URLSearchParams({
    limit: String(state.adminPayoutQuery.limit),
    sort: state.adminPayoutQuery.sort,
  });
  if (state.adminPayoutQuery.status) query.set('status', state.adminPayoutQuery.status);
  if (state.adminPayoutQuery.cursor) query.set('cursor', state.adminPayoutQuery.cursor);
  const response = await request(
    `/api/v1/admin/payouts?${query.toString()}`,
    {},
    'List Admin Payout approval queue',
  );
  const selectedId = state.selectedAdminPayout?.id;
  state.adminPayouts = response?.data?.items ?? [];
  state.adminPayoutNextCursor = response?.data?.nextCursor ?? null;
  const queuedSelection = state.adminPayouts.find((payout) => payout.id === selectedId);
  if (queuedSelection) state.selectedAdminPayout = queuedSelection;
  else state.selectedAdminPayout = state.adminPayouts[0] ?? null;
  renderAdminPayoutList();
  renderAdminPayoutDetail();
  renderAdminPaginationControls();
  setStatus(
    adminPayoutPageStatus,
    state.adminPayouts.length
      ? `Showing ${state.adminPayouts.length} Payout${state.adminPayouts.length === 1 ? '' : 's'}.`
      : 'No Payouts match this filter.',
    'info',
  );
  if (state.selectedAdminPayout) await loadAdminPayoutDetail(state.selectedAdminPayout.id);
  return response;
};

const loadNextAdminPayoutPage = async () => {
  if (!state.adminPayoutNextCursor) return null;
  state.adminPayoutCursorHistory.push(state.adminPayoutQuery.cursor);
  state.adminPayoutQuery.cursor = state.adminPayoutNextCursor;
  return loadAdminPayouts();
};

const loadPreviousAdminPayoutPage = async () => {
  if (!state.adminPayoutCursorHistory.length) return null;
  state.adminPayoutQuery.cursor = state.adminPayoutCursorHistory.pop() ?? null;
  return loadAdminPayouts();
};

const refreshAdminSession = async () => {
  try {
    const response = await request('/api/admin/auth/get-session', {}, 'Refresh Admin Session');
    state.adminSession = response?.user ? response : null;
    renderAdminAuth();
    if (state.adminSession) await loadAdminPayouts();
    return response;
  } catch (error) {
    state.adminSession = null;
    renderAdminAuth();
    debug('Admin session check failed', error instanceof Error ? error.message : error);
    return null;
  }
};

const signInAdmin = async () => {
  const email = adminEmailInput.value.trim();
  const password = adminPasswordInput.value;
  if (!email || !password) throw new Error('Enter the Admin email and password.');
  const response = await jsonRequest('/api/admin/auth/sign-in/email', 'POST', { email, password }, 'Admin sign-in');
  state.adminSession = response?.user ? response : null;
  adminPasswordInput.value = '';
  renderAdminAuth();
  if (!state.adminSession) throw new Error('Admin sign-in returned no Admin Session.');
  await loadAdminPayouts();
  return response;
};

const signOutAdmin = async () => {
  await jsonRequest('/api/admin/auth/sign-out', 'POST', {}, 'Admin sign-out');
  state.adminSession = null;
  state.adminPayouts = [];
  state.selectedAdminPayout = null;
  renderAdminAuth();
};

const approveSelectedAdminPayout = async () => {
  const payout = requireSelectedAdminWaitingPayout();
  if (!window.confirm('Approve this Payout? The Payout Worker can then call the Provider.')) return null;
  const note = document.querySelector('#admin-approval-note')?.value.trim();
  const body = note ? { note } : {};
  const response = await jsonRequest(
    `/api/v1/admin/payouts/${encodeURIComponent(payout.id)}/approve`,
    'POST',
    body,
    'Approve Payout',
    { 'idempotency-key': adminDecisionIdempotencyKey('APPROVE', payout.id, body) },
  );
  state.selectedAdminPayout = response?.data ?? payout;
  await loadAdminPayouts();
  await refreshWallet();
  return response;
};

const rejectSelectedAdminPayout = async () => {
  const payout = requireSelectedAdminWaitingPayout();
  const reason = document.querySelector('#admin-rejection-reason')?.value.trim() ?? '';
  if (!reason) throw new Error('Enter a rejection reason.');
  if (!window.confirm('Reject this Payout and release its Payout Reserve?')) return null;
  const body = { reason };
  const response = await jsonRequest(
    `/api/v1/admin/payouts/${encodeURIComponent(payout.id)}/reject`,
    'POST',
    body,
    'Reject Payout',
    { 'idempotency-key': adminDecisionIdempotencyKey('REJECT', payout.id, body) },
  );
  state.selectedAdminPayout = response?.data ?? payout;
  await loadAdminPayouts();
  await refreshWallet();
  return response;
};

const pages = {
  member: ['Member', 'Choose a Member, then continue to a task.'],
  quests: ['Quests', 'Create work, check funding, and manage your next step.'],
  chat: ['Work Chat', 'Open a live Work Conversation with Accepted Participants.'],
  wallet: ['Wallet & Payout', 'Check balances, get a Quote, and submit a Payout.'],
  admin: ['Admin Approval', 'Review Payouts with a separate Admin Session.'],
  explorer: ['API explorer', 'Use the full API contract for advanced tests.'],
  log: ['Request log', 'Inspect recent requests and redacted responses.'],
};
const announce = (message, type = 'info') => {
  const status = document.querySelector('#action-status');
  status.hidden = false;
  setStatus(status, message, type);
};
const navigate = () => {
  const key = Object.hasOwn(pages, location.hash.slice(1)) ? location.hash.slice(1) : 'member';
  document.querySelectorAll('[data-page]').forEach((page) => { page.hidden = page.dataset.page !== key; });
  document.querySelectorAll('[data-nav]').forEach((link) => {
    if (link.dataset.nav === key) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.querySelector('#page-title').textContent = pages[key][0];
  document.querySelector('#page-description').textContent = pages[key][1];
  document.querySelector('#action-status').hidden = true;
  document.querySelector('#main').focus({ preventScroll: true });
  if (key === 'explorer') {
    operationList.querySelectorAll('input[name="questId"]').forEach((input) => { input.value = selectedQuestId(); });
  }
};
const validPayoutQuote = () => Boolean(state.payoutQuote?.id && state.payoutQuoteAmount === document.querySelector('#payout-amount').value && new Date(state.payoutQuote.expiresAt).getTime() > Date.now());
const syncControls = () => {
  const hasMember = Boolean(state.session?.user?.id);
  const hasQuest = Boolean(selectedQuestId());
  const draft = state.quest?.state === 'QUEST_DRAFT';
  document.querySelector('#publish-quest').disabled = !hasMember || !hasQuest || !draft || !state.publishCheck?.canPublish;
  document.querySelector('#publish-check').disabled = !hasMember || !hasQuest;
  document.querySelector('#get-detail').disabled = !hasMember || !hasQuest;
  document.querySelector('#cancel-quest').disabled = !hasMember || !hasQuest || !['QUEST_DRAFT', 'QUEST_OPEN', 'QUEST_ASSIGNED', 'QUEST_IN_PROGRESS'].includes(state.quest?.state);
  document.querySelector('#submit-payout').disabled = !hasMember || !validPayoutQuote();
  syncChatControls();
  const memberBusy = [...document.querySelectorAll('.card[data-busy=true]')].some((card) => card.id !== 'admin-payout-panel');
  sessionOutput.closest('.card').querySelectorAll('button').forEach((button) => { button.disabled = memberBusy; });
  document.querySelectorAll('.card[data-busy=true]').forEach((card) => card.querySelectorAll('button, input, select, textarea').forEach((control) => { control.disabled = true; }));
};
const updateMember = () => {
  document.querySelector('#current-member').textContent = state.session?.user?.email || 'Sign in to begin';
  syncControls();
};
const clearMemberData = () => {
  state.payoutQuote = null; state.quest = null; state.publishCheck = null;
  questIdElement.value = '';
  document.querySelector('#quest-summary').textContent = 'No Quest selected.';
  document.querySelector('#quest-cards').replaceChildren();
  questOutput.textContent = 'Select a Quest for this Member.';
  payoutOutput.textContent = 'No Payout loaded for this Member.';
  document.querySelector('#payout-destination').textContent = 'Get a Quote to check the Payout Destination.';
  document.querySelector('#payout-status').textContent = 'Get a Quote before submitting a Payout.';
  renderWallet(null, null);
  Object.assign(chatState, { members: [], messages: [], conversationId: null, readOnly: true, conversations: [], nextCursor: null, messageCursor: null, pendingMessage: null, questTitle: null, questStatus: null });
  document.querySelector('#conversation-select').replaceChildren(new Option('Select a Conversation', ''));
  chatMessageInput.value = '';
  renderChatMode();
  setChatStatus('Sign in from the Member section, then refresh Conversations.');
};
const bind = (id, output, action, onSuccess = null) => document.querySelector(`#${id}`).addEventListener('click', () => runWithOutput(output, action, onSuccess));
bind('default-sign-in', sessionOutput, () => switchTestAccountSession('account-1'));
bind('account-2-sign-in', sessionOutput, () => switchTestAccountSession('account-2'));
bind('google-sign-in', sessionOutput, signInWithGoogle);
bind('refresh-session', sessionOutput, async () => { const session = await refreshSession(); await Promise.all([loadTags(), refreshWallet()]); return session; });
bind('sign-out', sessionOutput, signOut);
bind('refresh-wallet', document.querySelector('#wallet-status'), refreshWallet, () => {});
bind('list-mine', questOutput, listMine);
bind('list-board', questOutput, listBoard);
bind('get-detail', questOutput, getDetail);
bind('publish-check', questOutput, publishCheck);
bind('publish-quest', questOutput, publishQuest);
bind('cancel-quest', questOutput, async () => {
  const messages = {
    QUEST_DRAFT: 'Cancel this Draft? No money moves.',
    QUEST_OPEN: 'Cancel this Quest? Quest Escrow returns to the Hirer.',
    QUEST_ASSIGNED: 'Cancel this Quest? Active Workers receive 20% of the Worker Reward pool.',
    QUEST_IN_PROGRESS: 'Cancel this Quest? Full Worker Rewards and the Platform Fee are settled. The Hirer receives no refund.',
  };
  if (window.confirm(messages[state.quest?.state] || 'Cancel this Quest?')) return cancelQuest();
});
document.querySelector('#quest-form').addEventListener('submit', (event) => { event.preventDefault(); void runWithOutput(questOutput, createQuest); });
questIdElement.addEventListener('input', () => { state.quest = null; state.publishCheck = null; document.querySelector('#quest-summary').textContent = 'Load detail to check this Quest State.'; syncControls(); });
document.querySelector('#quest-participation').addEventListener('change', () => {
  const group = document.querySelector('#quest-participation').value === 'GROUP';
  const count = document.querySelector('#quest-headcount'); count.min = group ? '2' : '1'; count.max = group ? '20' : '1'; count.value = group ? '2' : '1';
});
document.querySelector('#quest-headcount').max = '1';
const bangkokInput = (minutes) => new Date(Date.now() + (420 + minutes) * 60000).toISOString().slice(0, 16);
document.querySelector('#quest-start').value = bangkokInput(60);
document.querySelector('#quest-due').value = bangkokInput(180);
bind('chat-load-live', chatStatus, () => loadLiveWorkConversation());
bind('chat-more-conversations', chatStatus, () => loadLiveWorkConversation(true));
bind('chat-older', chatStatus, loadOlderMessages);
document.querySelector('#conversation-select').addEventListener('change', (event) => runWithOutput(chatStatus, () => openConversation(event.target.value)));
chatMessageInput.addEventListener('input', updateChatCharacterCount);
chatComposer.addEventListener('submit', (event) => { event.preventDefault(); void runWithOutput(chatStatus, sendChatMessage); });
bind('quote-payout', payoutOutput, quotePayout);
bind('submit-payout', payoutOutput, submitPayout);
bind('list-payouts', payoutOutput, listPayouts);
document.querySelector('#payout-amount').addEventListener('input', () => { state.payoutQuote = null; document.querySelector('#payout-status').textContent = 'Amount changed. Get a new Quote.'; syncControls(); });
bind('run-payment', financeOutput, () => jsonRequest('/api/local/test/payment', 'POST', { creditSatang: readBahtInput('#payment-amount'), simulate: true }, 'Local Top-up test', { 'idempotency-key': financeKey('payment', '#payment-amount') }), renderPaymentResult);
bind('run-transfer', financeOutput, () => jsonRequest('/api/local/test/transfer', 'POST', { amountSatang: readBahtInput('#transfer-amount') }, 'Local Funding Reservation test', { 'idempotency-key': financeKey('transfer', '#transfer-amount') }));
const financeKeys = new Map();
const financeKey = (action, selector) => {
  const signature = `${action}:${document.querySelector(selector).value}`;
  if (!financeKeys.has(signature)) financeKeys.set(signature, randomKey(action));
  return financeKeys.get(signature);
};
bind('admin-sign-in', adminPayoutOutput, signInAdmin);
bind('admin-refresh-session', adminPayoutOutput, refreshAdminSession);
bind('admin-sign-out', adminPayoutOutput, signOutAdmin);
bind('admin-refresh-payouts', adminPayoutOutput, () => loadAdminPayouts({ reset: true }));
bind('admin-payout-previous', adminPayoutOutput, loadPreviousAdminPayoutPage);
bind('admin-payout-next', adminPayoutOutput, loadNextAdminPayoutPage);
[adminPayoutStatusInput, adminPayoutSortInput, adminPayoutLimitInput].forEach((input) => input.addEventListener('change', () => runWithOutput(adminPayoutOutput, () => loadAdminPayouts({ reset: true }))));
document.querySelector('#reload-operations').addEventListener('click', loadOperations);
operationFilter.addEventListener('change', renderOperations);
document.querySelector('#operation-search').addEventListener('input', renderOperations);
document.querySelector('#clear-debug').addEventListener('click', () => { debugLog.textContent = ''; });
document.querySelector('#server-origin').textContent = appOrigin;
window.addEventListener('hashchange', navigate);
setInterval(() => {
  const deadline = document.querySelector('#quest-deadline');
  if (deadline && state.quest?.dueAt) {
    const minutes = Math.ceil((new Date(state.quest.dueAt).getTime() - Date.now()) / 60000);
    deadline.textContent = `Due: ${new Date(state.quest.dueAt).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' })} (Asia/Bangkok) · ${minutes > 0 ? `${minutes} minutes remaining` : 'Deadline reached'}`;
  }
  if (state.payoutQuote && !validPayoutQuote()) {
    state.payoutQuote = null;
    document.querySelector('#payout-status').textContent = 'Quote expired. Get a new Quote to continue.';
    syncControls();
  }
}, 1000);
renderChatMode();
navigate();
void (async () => {
  await Promise.all([refreshSession(), refreshAdminSession(), loadOperations()]);
  if (state.session) await Promise.all([loadTags(), refreshWallet()]);
  syncControls();
})();
