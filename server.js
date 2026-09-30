const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || (IS_PRODUCTION ? '' : 'askme-local-development-secret');

if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be configured in production.');
}

if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}

const buildDefaultData = () => {
  const demoCredentials = hashPassword('demo');

  return {
    messages: [],
    accounts: IS_PRODUCTION ? [] : [
      {
        id: 1,
        displayName: 'Demo User',
        username: 'demo',
        passwordHash: demoCredentials.hash,
        passwordSalt: demoCredentials.salt,
        bio: 'Welcome to AskMe',
        darkMode: false
      }
    ],
    posts: [
      {
        id: 1,
        authorName: 'Anonymous',
        authorUsername: null,
        category: 'Life',
        text: 'What is a piece of advice you wish you knew earlier in your teens?',
        anonymous: true,
        likes: 24,
        likedBy: [],
        answers: [
          {
            id: 1,
            authorName: 'Alex',
            authorUsername: 'alex',
            text: "Don't stress over what people think—everyone is mostly focused on themselves anyway!"
          }
        ],
        createdAt: new Date().toISOString()
      },
      {
        id: 2,
        authorName: '@code_wizard',
        authorUsername: 'code_wizard',
        category: 'Tech',
        text: 'What is the best way to get started with Web Development in 2026?',
        anonymous: false,
        likes: 15,
        likedBy: [],
        answers: [],
        createdAt: new Date().toISOString()
      }
    ]
  };
};

const defaultData = buildDefaultData();

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
  }
}

function readData() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return JSON.parse(JSON.stringify(defaultData));
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const candidate = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return candidate === hash;
}

function normalizeRecoveryContact(value) {
  const contact = String(value || '').trim();
  if (contact.includes('@')) {
    const email = contact.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Enter a valid email address or phone number.');
    }
    return { type: 'email', value: email };
  }

  const digits = contact.replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) {
    throw new Error('Enter a valid email address or phone number.');
  }
  return { type: 'phone', value: contact.startsWith('+') ? `+${digits}` : digits };
}

function hasRecoveryDelivery(contactType) {
  if (!IS_PRODUCTION) return true;
  if (contactType === 'email') {
    return (process.env.SMTP_HOST && process.env.SMTP_FROM) ||
      (process.env.RESEND_API_KEY && process.env.RESEND_FROM);
  }
  return process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER;
}

async function deliverRecoveryCode(contact, code) {
  if (contact.type === 'email' && process.env.RESEND_API_KEY && process.env.RESEND_FROM) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM,
        to: [contact.value],
        subject: 'Your AskMe password reset code',
        text: `Your AskMe password reset code is ${code}. It expires in 10 minutes.`
      })
    });
    if (!response.ok) throw new Error('Email provider rejected the recovery message.');
    return;
  }

  if (contact.type === 'email' && process.env.SMTP_HOST && process.env.SMTP_FROM) {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      } : undefined
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: contact.value,
      subject: 'Your AskMe password reset code',
      text: `Your AskMe password reset code is ${code}. It expires in 10 minutes.`
    });
    return;
  }

  if (contact.type === 'phone' && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) {
    const credentials = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const body = new URLSearchParams({
      To: contact.value,
      From: process.env.TWILIO_FROM_NUMBER,
      Body: `Your AskMe password reset code is ${code}. It expires in 10 minutes.`
    });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });
    if (!response.ok) throw new Error('Unable to send a recovery text right now.');
    return;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Configure ${contact.type === 'email' ? 'SMTP' : 'Twilio'} before enabling password recovery.`);
  }

  console.log(`AskMe recovery code for ${contact.value}: ${code}`);
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    displayName: user.displayName,
    username: user.username,
    bio: user.bio || 'Exploring the AskMe community!',
    darkMode: !!user.darkMode
  };
}

function sanitizeOwnUser(user) {
  return { ...sanitizeUser(user), recoveryContact: user.recoveryContact || '' };
}

function sanitizePost(post) {
  return {
    id: post.id,
    authorName: post.authorName,
    authorUsername: post.authorUsername,
    category: post.category,
    text: post.text,
    anonymous: !!post.anonymous,
    likes: Number(post.likes || 0),
    likedBy: Array.isArray(post.likedBy) ? post.likedBy : [],
    answers: Array.isArray(post.answers) ? post.answers : [],
    createdAt: post.createdAt
  };
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));
app.use(
  session({
    store: IS_PRODUCTION ? new FileStore({
      path: path.join(DATA_DIR, 'sessions'),
      ttl: 7 * 24 * 60 * 60,
      retries: 0,
      logFn: () => {}
    }) : undefined,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PRODUCTION,
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'AskMe' });
});

app.get('/api/session', (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }

  const data = readData();
  const account = data.accounts.find((item) => item.id === Number(req.session.userId));

  if (!account) {
    req.session.destroy(() => {});
    return res.json({ user: null });
  }

  res.json({ user: sanitizeOwnUser(account) });
});

app.post('/api/signup', (req, res) => {
  const { displayName, username, password, recoveryContact } = req.body || {};
  if (!displayName || !username || !password || !recoveryContact) {
    return res.status(400).json({ message: 'Display name, username, password and a recovery email or phone are required.' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters.' });
  }

  const data = readData();
  const normalized = String(username).trim().replace('@', '').toLowerCase();
  let normalizedContact;
  try {
    normalizedContact = normalizeRecoveryContact(recoveryContact);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
  if (!normalized) {
    return res.status(400).json({ message: 'Username is required.' });
  }

  if (data.accounts.some((account) => account.username === normalized)) {
    return res.status(409).json({ message: 'Username already exists.' });
  }
  if (data.accounts.some((account) => account.recoveryContact === normalizedContact.value)) {
    return res.status(409).json({ message: 'That recovery email or phone is already linked to an account.' });
  }

  const passwordInfo = hashPassword(String(password));
  const newUser = {
    id: Date.now(),
    displayName: String(displayName).trim(),
    username: normalized,
    passwordHash: passwordInfo.hash,
    passwordSalt: passwordInfo.salt,
    recoveryContact: normalizedContact.value,
    recoveryType: normalizedContact.type,
    bio: 'Exploring the AskMe community!',
    darkMode: false
  };

  data.accounts.push(newUser);
  writeData(data);

  req.session.userId = newUser.id;
  req.session.user = sanitizeOwnUser(newUser);
  res.status(201).json({ user: sanitizeOwnUser(newUser) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  const data = readData();
  const normalized = String(username).trim().replace('@', '').toLowerCase();
  const account = data.accounts.find((item) => item.username === normalized);

  if (!account) {
    return res.status(401).json({ message: 'Invalid username or password.' });
  }

  const valid = verifyPassword(String(password), account.passwordSalt, account.passwordHash);
  if (!valid) {
    return res.status(401).json({ message: 'Invalid username or password.' });
  }

  req.session.userId = account.id;
  req.session.user = sanitizeOwnUser(account);
  res.json({ user: sanitizeOwnUser(account) });
});

app.post('/api/password/recovery/start', async (req, res) => {
  let contact;
  try {
    contact = normalizeRecoveryContact((req.body || {}).contact);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

  if (!hasRecoveryDelivery(contact.type)) {
    const setup = contact.type === 'email'
      ? 'Configure SMTP or Resend email delivery in the hosting settings.'
      : 'Configure Twilio SMS delivery in the hosting settings.';
    return res.status(503).json({ message: `Password recovery is not set up yet. ${setup}` });
  }

  const data = readData();
  const account = data.accounts.find((item) => item.recoveryContact === contact.value);
  const genericMessage = 'If that recovery contact belongs to an account, a code has been sent.';
  if (!account) {
    return res.json({ message: genericMessage });
  }

  data.recoveryChallenges = Array.isArray(data.recoveryChallenges) ? data.recoveryChallenges : [];
  const previousChallenge = data.recoveryChallenges.find((challenge) => challenge.accountId === account.id);
  if (previousChallenge && previousChallenge.sentAt > Date.now() - 60 * 1000) {
    return res.json({ message: genericMessage });
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const codeHash = hashPassword(code);
  data.recoveryChallenges = data.recoveryChallenges.filter((challenge) => challenge.accountId !== account.id);
  data.recoveryChallenges.push({
    accountId: account.id,
    codeHash: codeHash.hash,
    codeSalt: codeHash.salt,
    sentAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    attempts: 0
  });

  try {
    await deliverRecoveryCode(contact, code);
  } catch (error) {
    console.error('Password recovery delivery failed:', error.message);
    return res.status(503).json({ message: 'We could not send a recovery code right now. Please try again later.' });
  }

  writeData(data);
  res.json({ message: genericMessage });
});

app.post('/api/password/recovery/complete', (req, res) => {
  const { contact: rawContact, code, newPassword } = req.body || {};
  if (!code || String(newPassword || '').length < 8) {
    return res.status(400).json({ message: 'Enter the recovery code and a new password with at least 8 characters.' });
  }

  let contact;
  try {
    contact = normalizeRecoveryContact(rawContact);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

  const data = readData();
  const account = data.accounts.find((item) => item.recoveryContact === contact.value);
  const challenges = Array.isArray(data.recoveryChallenges) ? data.recoveryChallenges : [];
  const challenge = account && challenges.find((item) => item.accountId === account.id);
  if (!account || !challenge || challenge.expiresAt < Date.now() || challenge.attempts >= 5) {
    return res.status(400).json({ message: 'That code is invalid or expired. Request a new one.' });
  }

  if (!verifyPassword(String(code).trim(), challenge.codeSalt, challenge.codeHash)) {
    challenge.attempts += 1;
    writeData(data);
    return res.status(400).json({ message: 'That code is invalid or expired. Request a new one.' });
  }

  const passwordInfo = hashPassword(String(newPassword));
  account.passwordHash = passwordInfo.hash;
  account.passwordSalt = passwordInfo.salt;
  data.recoveryChallenges = challenges.filter((item) => item.accountId !== account.id);
  writeData(data);
  res.json({ message: 'Password reset. You can now log in with your new password.' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/users', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'You must be logged in.' });
  }

  const query = String(req.query.q || '').trim().toLowerCase();
  if (query.length < 2) {
    return res.json({ users: [] });
  }

  const data = readData();
  const users = data.accounts
    .filter((account) => account.id !== Number(req.session.userId))
    .filter((account) => account.username.toLowerCase().includes(query) || account.displayName.toLowerCase().includes(query))
    .slice(0, 20)
    .map(sanitizeUser);

  res.json({ users });
});

app.get('/api/notifications', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'You must be logged in.' });
  }

  const data = readData();
  const currentUserId = Number(req.session.userId);
  const unreadMessages = (Array.isArray(data.messages) ? data.messages : [])
    .filter((message) => message.recipientId === currentUserId)
    .filter((message) => !Array.isArray(message.readBy) || !message.readBy.includes(currentUserId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const messages = unreadMessages.slice(0, 20).map((message) => {
    const sender = data.accounts.find((account) => account.id === message.senderId);
    return {
      id: message.id,
      senderId: message.senderId,
      senderName: sender ? sender.displayName : 'Someone',
      senderUsername: sender ? sender.username : '',
      text: message.text,
      createdAt: message.createdAt
    };
  });

  res.json({ unreadCount: unreadMessages.length, messages });
});

app.get('/api/conversations', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'You must be logged in.' });
  }

  const data = readData();
  data.messages = Array.isArray(data.messages) ? data.messages : [];
  const currentUserId = Number(req.session.userId);
  const latestByUser = new Map();
  const unreadByUser = new Map();

  data.messages.forEach((message) => {
    if (message.senderId !== currentUserId && message.recipientId !== currentUserId) return;

    const otherUserId = message.senderId === currentUserId ? message.recipientId : message.senderId;
    if (message.recipientId === currentUserId && (!Array.isArray(message.readBy) || !message.readBy.includes(currentUserId))) {
      unreadByUser.set(otherUserId, (unreadByUser.get(otherUserId) || 0) + 1);
    }

    const previous = latestByUser.get(otherUserId);
    if (!previous || new Date(message.createdAt) > new Date(previous.createdAt)) {
      latestByUser.set(otherUserId, message);
    }
  });

  const conversations = [...latestByUser.entries()]
    .map(([otherUserId, lastMessage]) => {
      const account = data.accounts.find((item) => item.id === otherUserId);
      return account ? {
        user: sanitizeUser(account),
        lastMessage,
        unreadCount: unreadByUser.get(otherUserId) || 0
      } : null;
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt));

  res.json({ conversations });
});

app.get('/api/messages/:userId', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'You must be logged in.' });
  }

  const currentUserId = Number(req.session.userId);
  const otherUserId = Number(req.params.userId);
  const data = readData();
  const otherUser = data.accounts.find((account) => account.id === otherUserId);
  if (!otherUser || otherUserId === currentUserId) {
    return res.status(404).json({ message: 'User not found.' });
  }

  const conversationMessages = (Array.isArray(data.messages) ? data.messages : [])
    .filter((message) =>
      (message.senderId === currentUserId && message.recipientId === otherUserId) ||
      (message.senderId === otherUserId && message.recipientId === currentUserId)
    )
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  let changed = false;
  conversationMessages.forEach((message) => {
    if (message.recipientId !== currentUserId) return;
    message.readBy = Array.isArray(message.readBy) ? message.readBy : [];
    if (!message.readBy.includes(currentUserId)) {
      message.readBy.push(currentUserId);
      changed = true;
    }
  });

  if (changed) writeData(data);
  res.json({ messages: conversationMessages });
});

app.post('/api/messages/:userId', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'You must be logged in.' });
  }

  const currentUserId = Number(req.session.userId);
  const otherUserId = Number(req.params.userId);
  const text = String((req.body || {}).text || '').trim();
  const data = readData();
  const otherUser = data.accounts.find((account) => account.id === otherUserId);

  if (!otherUser || otherUserId === currentUserId) {
    return res.status(404).json({ message: 'User not found.' });
  }
  if (!text || text.length > 2000) {
    return res.status(400).json({ message: 'Messages must be between 1 and 2000 characters.' });
  }

  data.messages = Array.isArray(data.messages) ? data.messages : [];
  const message = {
    id: Date.now(),
    senderId: currentUserId,
    recipientId: otherUserId,
    text,
    readBy: [],
    createdAt: new Date().toISOString()
  };

  data.messages.push(message);
  writeData(data);
  res.status(201).json({ message });
});

app.get('/api/posts', (req, res) => {
  const data = readData();
  const posts = [...data.posts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ posts: posts.map(sanitizePost) });
});

app.post('/api/posts', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'You must be logged in.' });
  }

  const { text, category, anonymous } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ message: 'Question text is required.' });
  }

  const data = readData();
  const user = data.accounts.find((account) => account.id === Number(req.session.userId));
  if (!user) {
    return res.status(401).json({ message: 'User not found.' });
  }

  const newPost = {
    id: Date.now(),
    authorName: anonymous ? 'Anonymous' : user.displayName,
    authorUsername: anonymous ? null : user.username,
    category: category || 'General',
    text: String(text).trim(),
    anonymous: !!anonymous,
    likes: 0,
    likedBy: [],
    answers: [],
    createdAt: new Date().toISOString()
  };

  data.posts.unshift(newPost);
  writeData(data);

  res.status(201).json({ post: sanitizePost(newPost) });
});

app.post('/api/posts/:id/answers', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'You must be logged in.' });
  }

  const { text } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ message: 'Answer text is required.' });
  }

  const data = readData();
  const user = data.accounts.find((account) => account.id === Number(req.session.userId));
  if (!user) {
    return res.status(401).json({ message: 'User not found.' });
  }

  const post = data.posts.find((item) => item.id === Number(req.params.id));
  if (!post) {
    return res.status(404).json({ message: 'Post not found.' });
  }

  post.answers.push({
    id: Date.now(),
    authorName: user.displayName,
    authorUsername: user.username,
    text: String(text).trim()
  });

  writeData(data);
  res.status(201).json({ post: sanitizePost(post) });
});

app.post('/api/posts/:id/like', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'You must be logged in.' });
  }

  const data = readData();
  const post = data.posts.find((item) => item.id === Number(req.params.id));
  if (!post) {
    return res.status(404).json({ message: 'Post not found.' });
  }

  const userId = Number(req.session.userId);
  const alreadyLiked = post.likedBy.includes(userId);
  if (alreadyLiked) {
    post.likedBy = post.likedBy.filter((id) => id !== userId);
    post.likes = Math.max(0, Number(post.likes || 0) - 1);
  } else {
    post.likedBy.push(userId);
    post.likes = Number(post.likes || 0) + 1;
  }

  writeData(data);
  res.json({ post: sanitizePost(post) });
});

app.patch('/api/profile', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'You must be logged in.' });
  }

  const data = readData();
  const user = data.accounts.find((account) => account.id === Number(req.session.userId));
  if (!user) {
    return res.status(401).json({ message: 'User not found.' });
  }

  const { displayName, username, bio, darkMode, recoveryContact } = req.body || {};
  const nextUsername = String(username || user.username).trim().replace('@', '').toLowerCase();
  if (nextUsername && nextUsername !== user.username && data.accounts.some((account) => account.username === nextUsername && account.id !== user.id)) {
    return res.status(409).json({ message: 'Username already exists.' });
  }

  if (recoveryContact !== undefined && String(recoveryContact).trim()) {
    let normalizedContact;
    try {
      normalizedContact = normalizeRecoveryContact(recoveryContact);
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
    if (data.accounts.some((account) => account.recoveryContact === normalizedContact.value && account.id !== user.id)) {
      return res.status(409).json({ message: 'That recovery email or phone is already linked to an account.' });
    }
    user.recoveryContact = normalizedContact.value;
    user.recoveryType = normalizedContact.type;
  }

  user.displayName = String(displayName || user.displayName).trim() || user.displayName;
  user.username = nextUsername || user.username;
  user.bio = String(bio || user.bio || '').trim() || 'Exploring the AskMe community!';
  user.darkMode = !!darkMode;

  writeData(data);
  req.session.user = sanitizeOwnUser(user);
  res.json({ user: sanitizeOwnUser(user) });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AskMe running at http://localhost:${PORT}`);
});
