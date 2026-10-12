#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const bridge = require('./bridge.js');

const HOME = __dirname;
const BRIDGE = path.join(HOME, 'bridge.js');
const STATE = path.join(HOME, 'state.json');
const SESSIONS = path.join(HOME, 'sessions');
const HISTORY = path.join(HOME, 'history');
const UI = path.join(HOME, 'ui.html');
const TOKEN = crypto.randomBytes(24).toString('hex');

async function runBridge(args) {
  await bridge.run(args[0], args.slice(1));
  return '操作完成';
}

function lastQuestion(doc, status) {
  if (status !== 'waiting_user') return null;
  const heading = /^### (.+?) · (.+?) · ([^\r\n]+)$/gm;
  let item;
  let latestAsk;
  let latestReply = -1;
  while ((item = heading.exec(doc))) {
    if (item[2] === '向用户提问') latestAsk = {...item, index:item.index, start:heading.lastIndex};
    if (item[2] === '答复') latestReply = item.index;
  }
  if (latestAsk && latestAsk.index > latestReply) {
    const next = /^### .+? · .+? · [^\r\n]+$/gm;
    next.lastIndex = latestAsk.start;
    const following = next.exec(doc);
    const text = doc.slice(latestAsk.start, following ? following.index : undefined).replace(/\r?\n---\s*$/, '').trim();
    const id = /\(([^)]+)\)$/.exec(latestAsk[1]);
    return {text, asker:id ? id[1] : null};
  }
  const handoffs = [...doc.matchAll(/^### (.+?) · 交接 · [^\r\n]+\r?\n\r?\n将发言权交给 \*\*user\*\*。/gm)];
  const lastHandoff = handoffs.at(-1);
  const id = lastHandoff && /\(([^)]+)\)$/.exec(lastHandoff[1]);
  return lastHandoff ? {text:'', asker:id ? id[1] : null} : null;
}

function sessions(state) {
  const list = [];
  for (const [directory, prefix] of [[SESSIONS, ''], [HISTORY, 'legacy-']]) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).filter(item => /^[0-9TZ-]+\.discussion\.md$/.test(item))) {
      const id = name.slice(0, -'.discussion.md'.length);
      const file = path.join(directory, name);
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      const topic = lines.slice(1).find(line => line.trim() && !line.startsWith('##')) || '未命名会话';
      const saved = path.join(directory, `${id}.state.json`);
      const stateForSession = fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, 'utf8')) : null;
      list.push({id:prefix + id, topic:topic.trim(), active:!prefix && id === state?.discussionId,
        canContinue:!prefix && !!stateForSession, status:stateForSession?.status || null,
        mode:stateForSession?.mode || 'chat', speaker:stateForSession?.speaker || null});
    }
  }
  return list.sort((a, b) => b.id.replace(/^legacy-/, '').localeCompare(a.id.replace(/^legacy-/, '')));
}

async function snapshot() {
  const agents = bridge.readAgents();
  const state = fs.existsSync(STATE) ? bridge.getStatus() : null;
  const discussion = state && fs.existsSync(state.discussion) ? fs.readFileSync(state.discussion, 'utf8') : '';
  return {
    agents, state, discussion,
    pendingQuestion:lastQuestion(discussion, state && state.status),
    history:sessions(state),
    protocolPath:path.join(HOME, 'AGENTS.md'),
    bridgePath:BRIDGE,
    token:TOKEN
  };
}

async function continueSession(input) {
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message) throw new Error('请填写追问或答复');
  if (message.length > 100000) throw new Error('消息内容不得超过 10 万字符');
  const first = typeof input.first === 'string' ? input.first.trim() : '';
  const initial = bridge.getStatus();
  if (input.id && input.id !== initial.discussionId) {
    const target = sessions(initial).find(item => item.id === input.id && item.canContinue);
    if (!target) throw new Error('这个会话只能查看，无法继续');
    if (target.status === 'finished' && !bridge.readAgents().some(agent => agent.id === first)) throw new Error('请选择有效的开始 Agent');
    await bridge.run('switch', [input.id]);
  }
  let state = bridge.getStatus();
  if (state.status === 'paused') {
    await bridge.run('resume');
    state = bridge.getStatus();
  }
  if (state.status === 'finished') {
    if (!bridge.readAgents().some(agent => agent.id === first)) throw new Error('请选择有效的开始 Agent');
    await bridge.run('reopen', ['--first', first, '--text', message]);
  } else if (state.status === 'waiting_user') {
    const doc = fs.readFileSync(state.discussion, 'utf8');
    const question = lastQuestion(doc, state.status);
    const next = question?.asker || bridge.readAgents()[0].id;
    await bridge.run('reply', [next, '--text', message]);
  } else {
    await bridge.run('say', ['user', '--text', message]);
  }
  const updated = bridge.getStatus();
  return {output:'已记录，下一步请将提示词发送给当前 Agent', agent:updated.speaker};
}

let actionBusy = false;
async function performAction(input) {
  if (actionBusy) throw new Error('已有操作正在执行，请稍后再试');
  actionBusy = true;
  const previousLog = console.log;
  // Windows 终端选中文字时会暂停输出，浏览器操作不写终端，避免卡住页面服务。
  console.log = () => {};
  try {
    return input.action === 'continue' ? await continueSession(input) : {output:await runBridge(commandFor(input))};
  } finally {
    console.log = previousLog;
    actionBusy = false;
  }
}

function commandFor(input) {
  const text = value => typeof value === 'string' ? value.trim() : '';
  const required = (value, name) => {
    const result = text(value);
    if (!result) throw new Error(`请填写${name}`);
    return result;
  };
  switch (input.action) {
    case 'new': return ['new', '--topic', required(input.topic, '话题或任务'), '--mode', required(input.mode, '模式'), '--first', required(input.first, '首位 Agent')];
    case 'reopen': {
      const args = ['reopen', '--first', required(input.first, '首位 Agent'), '--mode', required(input.mode, '模式')];
      if (text(input.message)) args.push('--text', text(input.message));
      return args;
    }
    case 'switch': return ['switch', required(input.id, '会话 ID')];
    case 'reply': return ['reply', required(input.next, '下一位 Agent'), '--text', required(input.message, '答复')];
    case 'say': return ['say', 'user', '--text', required(input.message, '消息')];
    case 'mode': return ['mode', required(input.mode, '模式')];
    case 'pause': return ['pause'];
    case 'resume': return ['resume'];
    case 'finish': return ['finish', 'user'];
    case 'extend': return ['extend', '--messages', '20', '--handoffs', '5'];
    default: throw new Error('不支持的操作');
  }
}

function send(res, code, value, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {'Content-Type':type, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
  res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > 120000) throw new Error('内容过长');
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求内容不是有效 JSON'); }
}

function openBrowser(url) {
  if (process.env.AGENT_BRIDGE_NO_OPEN === '1') return;
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    command = 'open'; args = [url];
  } else {
    command = 'xdg-open'; args = [url];
  }
  const child = spawn(command, args, {detached:true, stdio:'ignore', windowsHide:true});
  child.on('error', () => console.log(`请手动打开：${url}`));
  child.unref();
}

const server = http.createServer(async (req, res) => {
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host) || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) {
    send(res, 403, {error:'仅允许本机访问'});
    return;
  }
  const url = new URL(req.url, origin);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      send(res, 200, fs.readFileSync(UI, 'utf8'), 'text/html; charset=utf-8');
    } else if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      send(res, 200, await snapshot());
    } else if (req.method === 'GET' && url.pathname.startsWith('/api/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/history/'.length));
      if (!/^(legacy-)?[0-9TZ-]+$/.test(id)) throw new Error('历史会话 ID 无效');
      const legacy = id.startsWith('legacy-');
      const file = path.join(legacy ? HISTORY : SESSIONS, `${legacy ? id.slice(7) : id}.discussion.md`);
      if (!fs.existsSync(file)) throw new Error('找不到这份历史记录');
      send(res, 200, {discussion:fs.readFileSync(file, 'utf8')});
    } else if (req.method === 'POST' && url.pathname === '/api/action') {
      if (req.headers['content-type'] !== 'application/json' || req.headers['x-bridge-token'] !== TOKEN) {
        send(res, 403, {error:'请求未获授权'});
        return;
      }
      const input = await readJson(req);
      send(res, 200, await performAction(input));
    } else {
      send(res, 404, {error:'页面不存在'});
    }
  } catch (error) {
    send(res, 400, {error:error.message});
  }
});

server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Agent Bridge 管理页面：${url}`);
  openBrowser(url);
});
