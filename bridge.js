#!/usr/bin/env node
'use strict';

/**
 * Agent Bridge — 零依赖、单机文件协作协议
 * Node.js >= 18，支持 Windows / macOS / Linux。
 * 任意数量已注册 Agent 共用发言权；本脚本不登录或启动 Agent，也不调用模型 API。
 */

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const HOME = __dirname;
const STATE = path.join(HOME, 'state.json');
const DOC = path.join(HOME, 'discussion.md');
const SESSIONS = path.join(HOME, 'sessions');
const LOCK = path.join(HOME, '.bridge.lock');
const CONFIG = path.join(HOME, 'agents.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const discussionTime = () => {
  const date = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

function fail(message) {
  throw new Error(message);
}
function argsOf(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (['stdin'].includes(name)) options[name] = true;
      else if (['help'].includes(name)) options[name] = true;
      else {
        if (i + 1 >= argv.length) fail(`参数 ${arg} 缺少值`);
        options[name] = argv[++i];
      }
    } else positional.push(arg);
  }
  return { options, positional };
}
function numberOpt(value, fallback, name, min = 1, max = 100000) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail(`${name} 必须是 ${min}～${max} 的整数`);
  return n;
}
function modeOpt(value) {
  if (!['chat', 'build'].includes(value)) fail('模式只能是 chat 或 build');
  return value;
}
function modeOf(state) {
  return state.mode || 'chat';
}
function readAgents() {
  if (!fs.existsSync(CONFIG)) fail(`缺少 Agent 配置文件：${CONFIG}；请创建 agents.json`);
  let config;
  try { config = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
  catch (e) { fail(`agents.json 解析失败：${e.message}`); }
  if (!config || !Array.isArray(config.agents) || config.agents.length < 1) fail('agents.json 的 agents 必须是非空数组');
  const used = new Set();
  return config.agents.map((agent, i) => {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) fail(`agents[${i}] 必须是对象`);
    const {id, name} = agent;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(id) || id === 'user') {
      fail(`agents[${i}].id 无效：只能使用小写字母、数字、_、-，必须以字母开头，不能使用 user`);
    }
    if (used.has(id)) fail(`agents.json 存在重复 ID：${id}`);
    used.add(id);
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || /[\r\n]/.test(name) || name.length > 60)) {
      fail(`agents[${i}].name 必须是 1～60 字符的单行文本`);
    }
    return {id, name: name || id};
  });
}
function member(value, permitUser = true) {
  if (value === 'user' && permitUser) return value;
  const ids = readAgents().map(agent => agent.id);
  if (!ids.includes(value)) fail(`未知参与者：${String(value)}（可用：${ids.join('、')}${permitUser ? '、user' : ''}）`);
  return value;
}
function displayName(actor) {
  if (actor === 'user') return '用户';
  const agent = readAgents().find(item => item.id === actor);
  return agent ? `${agent.name} (${agent.id})` : actor;
}
function readState() {
  if (!fs.existsSync(STATE)) fail('尚未初始化，请先运行 node bridge.js init');
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  if (state.speaker !== 'user') member(state.speaker, false);
  return state;
}
function sessionId(date = now()) {
  return new Date(date).toISOString().replace(/[:.]/g, '-');
}
function sessionFile(id, kind = 'discussion.md') {
  if (!/^[0-9TZ-]+$/.test(id)) fail(`会话 ID 无效：${id}`);
  return path.join(SESSIONS, `${id}.${kind}`);
}
function discussionFile(state) {
  return state.discussionId ? sessionFile(state.discussionId) : DOC;
}
function nextSessionId() {
  const base = sessionId();
  let id = base;
  let suffix = 1;
  while (fs.existsSync(sessionFile(id))) id = `${base}-${suffix++}`;
  return id;
}
function writeState(state) {
  state.updatedAt = now();
  const temp = path.join(HOME, `.state.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  try { fs.renameSync(temp, STATE); }
  catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}
async function withLock(work) {
  let handle;
  const start = Date.now();
  while (!handle) {
    try {
      handle = fs.openSync(LOCK, 'wx');
      fs.writeSync(handle, `${process.pid}\n${now()}\n`);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 不删除可能仍被正常进程持有的锁。异常退出留下锁时，可检查进程后手动移除。
      if (Date.now() - start > 10000) fail(`获取文件锁超时：${LOCK}；确认没有运行中的写入进程后可删除该锁文件`);
      await sleep(100);
    }
  }
  try { return await work(); }
  finally {
    fs.closeSync(handle);
    try { fs.unlinkSync(LOCK); } catch {}
  }
}
function getText(options) {
  const sources = ['text', 'file', 'stdin'].filter(k => options[k] !== undefined);
  if (sources.length !== 1) fail('内容请使用 --text "内容"、--file 路径 或 --stdin（只选一种）');
  let result;
  if (options.file !== undefined) result = fs.readFileSync(path.resolve(options.file), 'utf8');
  else if (options.stdin) result = fs.readFileSync(0, 'utf8');
  else result = options.text;
  result = result.trim();
  if (!result) fail('消息内容不能为空');
  if (result.length > 100000) fail('单条消息不得超过 10 万字符，请先整理为摘要');
  return result;
}
function append(author, kind, content) {
  const file = discussionFile(readState());
  if (!fs.existsSync(file)) fail(`缺少讨论文件：${file}`);
  const who = displayName(author);
  fs.appendFileSync(file, `\n### ${who} · ${kind} · ${discussionTime()}\n\n${content}\n\n---\n`, 'utf8');
}
function assertCanSpeak(state, actor) {
  if (state.status !== 'running') fail(`讨论不是运行状态（${state.status}）；请先处理暂停、用户回复或结束状态`);
  if (state.speaker !== actor) fail(`当前轮到 ${state.speaker}，不是 ${actor}；请先执行 wait ${actor}`);
}
function assertBudget(state, key, limitKey, kind) {
  if (state[key] >= state[limitKey]) fail(`已达到${kind}上限 ${state[limitKey]}，请由用户执行 extend 扩充额度，或结束讨论`);
}
function stateSummary(s) {
  return { mode:modeOf(s), status:s.status, speaker:s.speaker, speakerName:displayName(s.speaker), turn:s.turn,
    agents:readAgents(), messages:`${s.messages}/${s.maxMessages}`, handoffs:`${s.handoffs}/${s.maxHandoffs}`,
    build:s.build || null, pausedFrom:s.pausedFrom || null, updatedAt:s.updatedAt,
    discussionId:s.discussionId || null, discussion:discussionFile(s) };
}
function printState(s) {
  console.log(JSON.stringify(stateSummary(s), null, 2));
}
function newState(options, id) {
  const mode = options.mode === undefined ? 'chat' : modeOpt(options.mode);
  return {
    version: 3, discussionId:id, mode, status:'running', speaker: member(options.first || readAgents()[0].id, false),
    turn:1, messages:0, handoffs:0,
    maxMessages:numberOpt(options['max-messages'], 40, '--max-messages'),
    maxHandoffs:numberOpt(options['max-handoffs'], 10, '--max-handoffs'),
    build:mode === 'build' ? {executor:null, reviewer:null} : null,
    pausedFrom:null, createdAt:now(), updatedAt:now()
  };
}
function defaultDoc() {
  return '# 讨论主题\n\n请在这里填写要讨论的问题。\n\n## 规则\n\n- chat 模式只分析、讨论；用户切换到 build 模式后，可在当前任务范围内修改业务文件。\n- 基于实际项目文件和证据，不编造文件或代码。\n- 可以连续多次发言，不必强行轮换；存在分歧时保留分歧。\n- 不要直接改写本文件中的讨论记录，通过 bridge.js say 追加。\n\n## 讨论记录\n';
}
async function init(options, createNew = false) {
  await withLock(async () => {
    if (fs.existsSync(STATE) && !createNew) fail('已经初始化。如需新话题请用 new --topic "..."（旧话题会归档）');
    fs.mkdirSync(SESSIONS, {recursive:true});
    let id = nextSessionId();
    const s = newState(options, id);
    let content;
    if (createNew) {
      let topic = '# 讨论主题\n\n';
      if (options['topic-file']) topic += fs.readFileSync(path.resolve(options['topic-file']), 'utf8').trim() + '\n';
      else topic += (options.topic || '请填写本次讨论主题。') + '\n';
      const base = defaultDoc();
      content = topic + base.slice(base.indexOf('## 规则'));
    } else content = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : defaultDoc();
    const legacy = fs.existsSync(STATE) && !readState().discussionId;
    if (createNew && fs.existsSync(STATE)) {
      const previous = readState();
      if (legacy) {
        const oldBase = sessionId(previous.createdAt || previous.updatedAt || now());
        let oldId = oldBase;
        let suffix = 1;
        while (fs.existsSync(sessionFile(oldId))) oldId = `${oldBase}-${suffix++}`;
        const oldDoc = sessionFile(oldId);
        if (!fs.existsSync(DOC)) fail(`缺少讨论文件：${DOC}`);
        fs.copyFileSync(DOC, oldDoc);
        previous.discussionId = oldId;
        if (id === oldId) { id = nextSessionId(); s.discussionId = id; }
      }
      fs.writeFileSync(sessionFile(previous.discussionId, 'state.json'), JSON.stringify(previous, null, 2) + '\n', 'utf8');
    }
    fs.writeFileSync(sessionFile(id), content, {encoding:'utf8', flag:'wx'});
    writeState(s);
    append('user', '启动讨论', `当前首位发言者：${s.speaker}。`);
    if ((legacy || !createNew) && fs.existsSync(DOC)) fs.unlinkSync(DOC);
    console.log(`${s.mode} 模式已启动，轮到 ${s.speaker}。\n文件：${discussionFile(s)}`);
  });
}
async function say(actor, options) {
  const content = getText(options);
  await withLock(async () => {
    const s = readState();
    if (actor !== 'user') {
      assertCanSpeak(s, actor);
      assertBudget(s, 'messages', 'maxMessages', '消息数');
      s.messages++;
    }
    append(actor, actor === 'user' ? '插话' : '发言', content);
    writeState(s);
    console.log(`已记录 ${actor} 的消息；当前发言权：${s.speaker}。`);
  });
}
async function setMode(value) {
  const mode = modeOpt(value);
  await withLock(async () => {
    const s = readState();
    if (s.status === 'finished') fail('讨论已结束；请用 reopen 恢复或用 new --mode 开启新话题');
    if (modeOf(s) === mode) { console.log(`当前已是 ${mode} 模式`); return; }
    s.mode = mode;
    s.build = mode === 'build' ? {executor:null, reviewer:null} : null;
    append('user', '切换模式', `切换为 **${mode}** 模式。`);
    writeState(s);
    console.log(`MODE_OK：已切换为 ${mode} 模式；当前状态仍为 ${s.status}，轮到 ${s.speaker}。`);
  });
}
async function submit(actor, options) {
  member(actor, false);
  const summary = getText(options);
  await withLock(async () => {
    const s = readState();
    assertCanSpeak(s, actor);
    if (modeOf(s) !== 'build') fail('submit 仅用于 build 模式');
    assertBudget(s, 'messages', 'maxMessages', '消息数');
    s.messages++;
    s.build = {executor:actor, reviewer:null};
    append(actor, '提交执行结果', summary);
    writeState(s);
    console.log(`SUBMIT_OK：${actor} 已提交执行结果；请 handoff 给其他 Agent 审核。`);
  });
}
async function approve(actor, options) {
  member(actor, false);
  const review = getText(options);
  await withLock(async () => {
    const s = readState();
    assertCanSpeak(s, actor);
    if (modeOf(s) !== 'build') fail('approve 仅用于 build 模式');
    if (!s.build || !s.build.executor) fail('尚无执行结果；请执行者先使用 submit');
    if (s.build.executor === actor) fail('执行者不能审核自己的结果');
    assertBudget(s, 'messages', 'maxMessages', '消息数');
    s.messages++;
    s.build.reviewer = actor;
    append(actor, '审核确认', review);
    writeState(s);
    console.log(`APPROVE_OK：${actor} 已确认 ${s.build.executor} 的执行结果；可结束会话。`);
  });
}
async function handoff(from, to) {
  member(from, false); member(to);
  if (from === to) fail('连续发言只需继续使用 say，无需 handoff 给自己');
  await withLock(async () => {
    const s = readState();
    assertCanSpeak(s, from);
    assertBudget(s, 'handoffs', 'maxHandoffs', '交接次数');
    s.handoffs++;
    s.turn++;
    if (modeOf(s) === 'build' && s.build && s.build.reviewer && to === s.build.executor) s.build.reviewer = null;
    s.speaker = to;
    if (to === 'user') s.status = 'waiting_user';
    append(from, '交接', `将发言权交给 **${to}**。`);
    writeState(s);
    console.log(`HANDOFF_OK：已交给 ${to}（第 ${s.turn} 个发言阶段）`);
  });
}
async function ask(from, options) {
  member(from, false);
  const question = getText(options);
  await withLock(async () => {
    const s = readState();
    assertCanSpeak(s, from);
    assertBudget(s, 'handoffs', 'maxHandoffs', '交接次数');
    s.handoffs++;
    s.turn++;
    s.speaker='user';
    s.status='waiting_user';
    append(from, '向用户提问', question);
    writeState(s);
    console.log(`WAITING_USER：已暂停讨论。请在当前客户端向用户完整展示以下问题；收到用户的直接答复后，执行 reply ${from} --text "用户答复" 记录并继续（用户指定下一位时使用其 ID）：\n${question}`);
  });
}
async function reply(next, options) {
  member(next, false);
  const content=getText(options);
  await withLock(async () => {
    const s=readState();
    if (s.status!=='waiting_user' || s.speaker!=='user') fail('当前没有等待用户答复的问题；普通插话请使用 say user');
    append('user', '答复', content);
    s.status='running'; s.speaker=next; s.turn++;
    writeState(s);
    console.log(`REPLY_OK：已答复，下一位是 ${next}`);
  });
}
async function pause() {
  await withLock(async () => {
    const s=readState();
    if (s.status==='paused') { console.log('已经暂停'); return; }
    if (!['running','waiting_user'].includes(s.status)) fail(`无法暂停状态 ${s.status}`);
    s.pausedFrom=s.status; s.status='paused';
    append('user', '控制', '暂停讨论。'); writeState(s);
    console.log('已暂停；正在执行的 Agent 操作不会自动被强制中止。');
  });
}
async function resume() {
  await withLock(async () => {
    const s=readState();
    if (s.status!=='paused') fail('当前未暂停');
    s.status=s.pausedFrom || 'running'; s.pausedFrom=null;
    append('user','控制','继续讨论。'); writeState(s);
    console.log(`已恢复；当前轮到 ${s.speaker}。`);
  });
}
async function finish(actor) {
  member(actor);
  await withLock(async () => {
    const s=readState();
    if (s.status==='finished') { console.log('已结束'); return; }
    if (actor!=='user') {
      assertCanSpeak(s,actor);
      if (modeOf(s) === 'build' && (!s.build || !s.build.executor || !s.build.reviewer)) {
        fail('build 模式需执行者 submit、另一位 Agent approve 后才能结束；用户可随时执行 finish user');
      }
    }
    s.status='finished';
    append(actor,'结束讨论',modeOf(s) === 'build' ? '任务已结束。请以当前会话记录中的执行结果和审核结论为准。' : '讨论已结束。请以当前会话记录中的实际结论和分歧为准。');
    writeState(s);
    console.log('FINISHED：讨论已结束。');
  });
}
async function reopen(options) {
  const first = member(options.first || readAgents()[0].id, false);
  const mode = options.mode === undefined ? null : modeOpt(options.mode);
  const hasQuestion = ['text', 'file', 'stdin'].some(key => options[key] !== undefined);
  const question = hasQuestion ? getText(options) : null;
  await withLock(async () => {
    const s = readState();
    if (s.status !== 'finished') fail(`当前状态是 ${s.status}，只有已结束的讨论才能 reopen。进行中的讨论可用 say user 追加问题。`);
    s.status = 'running';
    s.speaker = first;
    s.turn++;
    s.pausedFrom = null;
    if (mode) s.mode = mode;
    s.build = modeOf(s) === 'build' ? {executor:null, reviewer:null} : null;
    append('user', question ? '追问' : '重新开启', question || `继续原讨论，下一位发言者：**${first}**。`);
    writeState(s);
    console.log(`REOPEN_OK：已恢复原讨论，轮到 ${first}。记录仍在 ${discussionFile(s)}。`);
  });
}
async function switchSession(id) {
  if (!/^[0-9TZ-]+$/.test(id || '')) fail('请指定有效的会话 ID');
  await withLock(async () => {
    const current = readState();
    if (current.discussionId === id) { console.log(`已是当前会话：${id}`); return; }
    const file = sessionFile(id);
    const saved = sessionFile(id, 'state.json');
    if (!fs.existsSync(file) || !fs.existsSync(saved)) fail(`找不到可继续的会话：${id}`);
    if (!current.discussionId) fail('请先用 new 创建新会话，迁移旧版讨论记录');
    const target = JSON.parse(fs.readFileSync(saved, 'utf8'));
    target.discussionId = id;
    fs.writeFileSync(sessionFile(current.discussionId, 'state.json'), JSON.stringify(current, null, 2) + '\n', 'utf8');
    writeState(target);
    console.log(`已切换到 ${id}；状态 ${target.status}，记录：${file}`);
  });
}
async function extend(options) {
  const messages=numberOpt(options.messages,0,'--messages',0,100000);
  const handoffs=numberOpt(options.handoffs,0,'--handoffs',0,100000);
  if (!messages && !handoffs) fail('至少需要指定 --messages 数量或 --handoffs 数量');
  await withLock(async () => {
    const s=readState();
    s.maxMessages+=messages; s.maxHandoffs+=handoffs;
    writeState(s);
    console.log(`已扩充限制：消息 ${s.maxMessages} 条，交接 ${s.maxHandoffs} 次。`);
  });
}
async function wait(actor, options) {
  member(actor,false);
  const seconds=numberOpt(options.timeout,45,'--timeout',1,3600);
  const started=Date.now();
  while (true) {
    const s=readState();
    if (s.status==='finished') { console.log('FINISHED：讨论已结束，不再等待'); return; }
    if (s.status==='running' && s.speaker===actor) {
      const instruction = modeOf(s) === 'build' ? '请按 build 协议执行、提交或审核，确认后再结束。' : '请使用 say 发言；结束时 handoff/ask/finish。';
      console.log(`TURN_READY：轮到 ${actor}。阶段 ${s.turn}。请按需查看 status.discussion 指向文件中的新增记录，先检查用户最新意见。${instruction}`);
      return;
    }
    if (Date.now()-started>=seconds*1000) {
      console.log(`WAIT_TIMEOUT：尚未轮到 ${actor}；状态 ${s.status}，当前 ${s.speaker}。如客户端支持，可再次执行 wait。`);
      return;
    }
    await sleep(750);
  }
}
function help() {
  console.log(`Agent Bridge（Node.js 18+，无额外依赖）

在项目内执行：node .agent-bridge/bridge.js <命令>
Agent ID 来自 .agent-bridge/agents.json，不限制 Agent 数量。

  agents                                                列出已注册 Agent
  init [--first <id>] [--mode chat|build] [--max-messages 40] [--max-handoffs 10]
  new --topic "新话题" [--first <id>] [--mode chat|build] 归档旧讨论并新开一场
  new --topic-file <文件路径>
  reopen [--first <id>] [--mode chat|build] [--text "追问"]
  reopen [--first <id>] --file <UTF-8文件>            用文件内容继续原讨论
  switch <会话ID>                                      切换到 sessions 中的旧会话
  mode chat|build                                       切换当前会话模式
  status                                                查看发言权/状态
  wait <id> [--timeout 45]                              等待轮到自己（超时不报错）
  say <id|user> --text "消息"                            追加发言
  say <id|user> --file <文件路径>                         以 UTF-8 文件内容发言
  say <id|user> --stdin                                 标准输入发言
  handoff <来源id> <目标id|user>                        交接发言权
  ask <id> --text "问题"                                向用户提问并等待
  reply <id> --text "用户答复"                           回答并指定下一位
  submit <id> --text "执行结果"                         build 模式：执行者提交结果
  approve <id> --text "审核结论"                        build 模式：另一位 Agent 确认结果
  pause / resume                                        暂停 / 恢复
  extend --messages 20 --handoffs 5                     增加额度
  finish <id|user>                                      结束本次讨论
  help

注意：脚本不启动或唤醒客户端。修改 agents.json 可加入新 Agent，但不能删除当前发言者。`);
}
async function run(command, argv = []) {
  const {options,positional} = argsOf(argv);
  switch(command) {
    case 'init': await init(options); break;
    case 'new': await init(options,true); break;
    case 'reopen': await reopen(options); break;
    case 'switch': await switchSession(positional[0]); break;
    case 'mode': await setMode(positional[0]); break;
    case 'status': printState(readState()); break;
    case 'agents': console.log(JSON.stringify(readAgents(), null, 2)); break;
    case 'wait': await wait(positional[0],options); break;
    case 'say': member(positional[0]); await say(positional[0],options); break;
    case 'handoff': await handoff(positional[0],positional[1]); break;
    case 'ask': await ask(positional[0],options); break;
    case 'reply': await reply(positional[0],options); break;
    case 'submit': await submit(positional[0],options); break;
    case 'approve': await approve(positional[0],options); break;
    case 'pause': await pause(); break;
    case 'resume': await resume(); break;
    case 'finish': await finish(positional[0]); break;
    case 'extend': await extend(options); break;
    case 'help': case undefined: help(); break;
    default: fail(`未知命令：${command}。执行 node bridge.js help 查看帮助。`);
  }
}
if (require.main === module) {
  const [command, ...argv] = process.argv.slice(2);
  run(command, argv).catch(e => { console.error(`ERROR: ${e.message}`); process.exitCode=1; });
}
module.exports = {run, readAgents, getStatus:() => stateSummary(readState())};
