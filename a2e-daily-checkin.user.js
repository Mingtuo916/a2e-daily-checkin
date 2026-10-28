// ==UserScript==
// @name         A2E 每日签到（多账号轮询）
// @namespace    https://video.a2e.ai/
// @version      1.0.14
// @description  多账号依次登录 → 领取每日免费积分 → 退出 → 切换下一个账号；账号/密码改由页面面板录入（脚本内不含任何凭据），面板实时显示今日已完成数量。
// @author       you
// @match        https://video.a2e.ai/*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @noframes
// ==/UserScript==

/* ============================================================================
 * ⚠️ 使用说明（务必阅读）
 * 1. 本脚本**不再内置任何账号或密码**。登录后页面左下角会出现一个签到悬浮按钮，
 *    点开即可添加账号（邮箱 + 密码）、批量导入、删除 / 排序；账号保存在脚本管理器
 *    （Tampermonkey）的持久化存储里，升级脚本不会丢失。
 * 2. 平台有风控：短时间批量登录、批量领奖可能触发"操作频繁/上限"，
 *    严重时导致积分冻结或封号。请自行控制账号数量与运行频率（建议每天一次）。
 * 3. 脚本依赖页面 DOM。站点改版后选择器可能失效，届时按注释里的"备用定位"更新。
 * ========================================================================== */

(function () {
  'use strict';

  /* =========================== 配置区（按需修改） =========================== */

  /* ---------------------- 账号库（由面板录入，脚本内不含凭据） ----------------------
   * 存储：GM 存储 `a2e_accounts` = [{ email, password }, ...]（按处理顺序排列）
   * 为什么不用 localStorage 双写：localStorage 对站点自己的 JS 可读，把密码放进去
   * 等于把凭据暴露给页面；GM 存储是脚本管理器隔离的。只有 GM 存储不可用时才退回
   * localStorage 兜底（见 accountsSet）。
   * ------------------------------------------------------------------------------ */
  const K_ACCOUNTS = 'a2e_accounts';
  const CREDS_LS = 'a2e_creds:';   // 仅 GM 存储不可用时的兜底 key 前缀

  /** 取账号邮箱（兼容旧版的纯字符串数组）。 */
  function emailOf(a) {
    return String((a && typeof a === 'object' ? a.email : a) || '').trim();
  }

  /** 清洗账号列表：丢掉空邮箱/非法邮箱，按邮箱去重（保留首次出现），密码统一转字符串。 */
  function normalizeAccounts(raw) {
    const list = [];
    const seen = new Set();
    for (const it of (Array.isArray(raw) ? raw : [])) {
      const email = emailOf(it);
      if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ email, password: String((it && typeof it === 'object' && it.password) || '') });
    }
    return list;
  }

  function accountsGet() {
    try {
      const v = GM_getValue(K_ACCOUNTS, null);
      if (Array.isArray(v)) return normalizeAccounts(v);
    } catch (e) { /* GM 存储不可用 → 走兜底 */ }
    try {
      const raw = localStorage.getItem(CREDS_LS + K_ACCOUNTS);
      if (raw) return normalizeAccounts(JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return [];
  }

  function accountsSet(list) {
    const data = normalizeAccounts(list);
    let ok = false;
    try { GM_setValue(K_ACCOUNTS, data); ok = true; } catch (e) { ok = false; }
    if (!ok) {
      try { localStorage.setItem(CREDS_LS + K_ACCOUNTS, JSON.stringify(data)); } catch (e) { /* ignore */ }
    }
    return data;
  }

  /** 今日已完成账号的集合（小写）。一次读完再比对，避免每个账号都读一次存储。 */
  function doneEmailSet() {
    return new Set(doneSet().map((e) => String(e).toLowerCase()));
  }

  /** 今日已完成的账号数（只统计当前列表里的账号）。
   *  用途：面板顶部"x/y"、悬浮角标、结束通知、菜单「查看今日签到进度」。 */
  function todayDoneCount() {
    const list = accountsGet();
    if (!list.length) return 0;
    const done = doneEmailSet();
    return list.filter((a) => done.has(a.email.toLowerCase())).length;
  }

  /* --------------------------- 存储 key（状态机） --------------------------- */
  const K_DONE_DATE = 'a2e_done_date';   // 'YYYY-MM-DD'，当天全部跑完的标记
  const K_INDEX = 'a2e_index';           // 当前处理到的账号下标
  const K_LOG = 'a2e_log';               // 运行日志数组
  const K_RETRY = 'a2e_retry_';          // a2e_retry_<email> 单账号重试次数
  const K_GUARD = 'a2e_guard';           // 防刷新风暴 {t,n}
  const K_CHECKIN = 'a2e_checkin';       // 跨刷新的签到等待状态 {email, at}
  const K_PEND = 'a2e_pending_login';    // 刚提交登录的标记 {email, at, tries}（跨刷新等会话落地）
  const K_DONE_SET = 'a2e_done_set';     // 今日已完成账号 {date, emails[]}（防重复处理/防索引死循环）
  const K_LOUT = 'a2e_logout_at';        // 刚清掉 token cookie 的时间戳（下一轮加载可跳过 8s 水合等待）
  const K_RUN_DATE = 'a2e_run_date';     // 本轮运行归属的任务日（跨 08:00 边界时不中途切换）
  const K_LOCK = 'lock';                 // 单例锁心跳 {id, at}（实际 key 为 a2e_sync:lock）
  const K_RETRY_POINTS = 'a2e_retry_points_'; // a2e_retry_points_<email> 读不到积分：独立重试计数

  const MAX_RETRY_LIMIT = 3;   // 限制类提示：最多 3 次
  const MAX_RETRY_TIMEOUT = 2; // 超时无明确文案：最多 2 次
  const MAX_RETRY_LOGIN = 3;   // 登录连续失败 3 次停止本轮
  const MAX_RETRY_POINTS = 2;  // 读不到积分：最多 2 次刷新重试，之后才跳过该账号
  const LOCK_TTL = 90000;      // 单例锁存活 90s（容忍单次 reload 期间 30s 心跳的空窗）
  const LOCK_RENEW = 30000;    // 锁续期间隔 30s

  /* ------------------------------- 等待时长 -------------------------------- */
  const T = {
    pageReady: 45000,      // 等页面水合（出现账号按钮或登录入口），实测偶发 20s+
    claimDialog: 60000,    // 累计等"每日奖励"弹窗的总时长（跨刷新累加，见 handleCheckIn）
    claimSlice: 30000,     // 单次加载里最多等多久，剩下的留到下一轮加载继续
    pointsIncrease: 70000, // 点"立即领取"后等积分上涨（实测 10s ~ 45s，Turnstile 慢时更久）
    claimProbe: 6000,      // 登录后先观察这么久：没自动弹窗就主动点右上角签到图标
    maxClaimClicks: 3,     // 积分不动时最多点几次
    pollStep: 800,
    loginSettle: 90000,    // 提交登录后等"账号按钮出现"的总时长（站点整页刷新后再水合）
    authSettle: 8000,      // 页龄小于此值不采信"只有登录入口 = 未登录"（水合期 header 会先渲染 Sign-in）
    stableFor: 1500,       // 判"未登录"还要求连续两次采样一致
  };

  /* ============================ 选择器（真实抓取） ===========================
   * 稳定性评级说明：
   *   稳定           —— 语义属性（name / id / role），极少变
   *   可能随版本变化 —— 设计系统属性（data-slot / data-variant），改版可能改名
   *   不稳定         —— 动态 class 或纯文本（站点用了自动翻译，文本会被改写）
   * ======================================================================== */
  const SEL = {
    // header 里的积分：<span class="p-icon p-icon--coin"> 后面紧跟数字。
    // 评级：可能随版本变化（class 来自 CSS module）。备用：读页面 3s 轮询的
    //      GET /api/v1/user/remainingCoins 的 UI 展示，或用账号按钮旁的数字。
    coinIcon: 'header span.p-icon--coin',

    // 已登录标志：右上角账号按钮，文本就是邮箱。
    // 评级：可能随版本变化（data-slot 来自 shadcn/radix 设计系统）。
    accountTrigger: 'button[data-slot="dropdown-menu-trigger"]',

    // 退出菜单项：div[role=menuitem][data-slot=dropdown-menu-item]，最后一项是 Log out。
    // 评级：可能随版本变化。备用：文本 /log out|退出|登出/i，或 svg.lucide-log-out。
    menuItem: '[role="menuitem"]',

    // 登录弹窗的邮箱/密码：name 属性最稳。
    // 评级：稳定。placeholder 会被浏览器自动翻译，别用。
    emailInput: 'input[name="username"]',
    passwordInput: 'input[name="password"]',

    // 弹窗里的主按钮：登录弹窗里是"登入"，签到弹窗里是"立即领取/Claim Now"。
    // 评级：可能随版本变化（data-variant 来自设计系统）。备用：弹窗内
    //      button 中文本匹配 /claim now|立即领取|领取/，再兜底取"非 outline"的那个。
    dialogPrimary: 'button[data-slot="button"], button',
    dialogPrimaryVariant: 'default',

    // Turnstile 容器（签到弹窗内，显式 id，最稳）。容器里会有
    // input[name="cf-turnstile-response"] 和/或 challenges.cloudflare.com 的 iframe。
    // 评级：稳定。
    turnstileBox: '#turnstile-checkin-container',
    turnstileIframe: 'iframe[src*="challenges.cloudflare.com"]',

    // 弹窗关闭按钮。
    // 评级：可能随版本变化。备用：文本 /close|关闭/i。
    dialogClose: 'button[data-slot="dialog-close"]',

    // sonner toast 容器（站点用它弹"请先上传源图像"等提示）。
    // 评级：可能随版本变化。备用：观察 body 文本。
    toast: '[data-sonner-toast]',

    // header 右上角「签到」图标（Referral Bonus 和主题切换之间那个小礼物/闪光图标，
    // 鼠标悬停提示 "Check-in Rewards"）。是个 div（不是 button），带 Radix 的
    // data-slot="tooltip-trigger" + size-8。
    // 用途：今日已签到的账号登录后**站点不会自动弹窗**，只能点这个按钮主动问一次。
    // 评级：可能随版本变化（data-slot 来自设计系统）。备用：见 findCheckinTrigger()。
    checkinTrigger: '[data-slot="tooltip-trigger"].size-8',
  };

  /* ================================ 工具函数 ================================ */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 轮询直到 fn 返回真值；超时返回 null。 */
  async function waitFor(fn, timeout = 20000, interval = 400) {
    const end = Date.now() + timeout;
    for (;;) {
      try {
        const v = fn();
        if (v) return v;
      } catch (e) { /* 页面重渲染瞬间可能抛错，忽略 */ }
      if (Date.now() >= end) return null;
      await sleep(interval);
    }
  }

  /** ⚠️ 数字专用版本：`waitFor` 用真值判断，而**积分 0 是合法的 0**，
   *  用 waitFor 读积分会把新账号（0 分）当成"读不到积分"跳过。
   *  实测（第五轮）：qianer1995 积分 0，waitFor 空等 30s 后判读不到 → 跳过，
   *  签到弹窗明明开着却从不点。这里改成"非 null 即成功"。
   */
  async function waitForValue(fn, timeout = 20000, interval = 400) {
    const end = Date.now() + timeout;
    for (;;) {
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v !== null && v !== undefined) return v;
      if (Date.now() >= end) return null;
      await sleep(interval);
    }
  }


  const textOf = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

  /** 按文本找按钮；texts 支持字符串或正则数组。 */
  function findButtonByText(texts, root = document) {
    const list = typeof texts === 'string' ? [texts] : texts;
    const nodes = (root || document).querySelectorAll('button, [role="button"], [role="menuitem"], a');
    for (const n of nodes) {
      const t = textOf(n);
      if (!t || t.length > 40) continue;
      if (list.some((x) => (x instanceof RegExp ? x.test(t) : t.includes(x)))) return n;
    }
    return null;
  }

  /** 等指定文本的按钮出现。 */
  async function waitForButtonByText(texts, root = document, timeout = 15000) {
    return waitFor(() => findButtonByText(texts, root), timeout, 300);
  }

  /** 点击元素。
   *  实测坑：用合成 MouseEvent 序列（pointerdown→mouseup→click）点站点的
   *  「Sign In」提交按钮，**请求根本不发**（network 里没有任何登录接口），
   *  而原生 el.click() 可以触发；Radix 的菜单项/触发器两种都吃。
   *  所以统一优先用原生 click()，只有元素没有 click() 时才退回合成事件。 */
  function clickEl(el) {
    if (!el) return false;
    try { if (el.focus) el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    if (typeof el.click === 'function') {
      try { el.click(); return true; } catch (e) { /* 继续兜底 */ }
    }
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
      try {
        const Ev = type.startsWith('pointer') ? (window.PointerEvent || window.MouseEvent) : window.MouseEvent;
        el.dispatchEvent(new Ev(type, opts));
      } catch (e) { /* ignore */ }
    });
    return true;
  }

  /** 打开 Radix 的下拉菜单（header 的账号按钮）。
   *  ⚠️ 实测坑（第五轮）：`button[data-slot="dropdown-menu-trigger"]` 是 Radix 触发器，
   *  原生 el.click() **打不开**（实测点完 role=menuitem 数量还是 0）→ doLogout 永远
   *  "退出未确认"，人一直登着旧账号，索引和目标账号来回对冲成死循环。
   *  必须补发 pointerdown → mousedown → pointerup → mouseup → click 完整序列。 */
  function clickMenuTrigger(el) {
    if (!el) return false;
    try { if (el.focus) el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    const base = { bubbles: true, cancelable: true, view: window, button: 0 };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const fire = (Ctor, type, opts) => { try { el.dispatchEvent(new Ctor(type, opts)); } catch (e) { /* ignore */ } };
    fire(window.PointerEvent || window.MouseEvent, 'pointerdown', { ...ptr, buttons: 1 });
    fire(window.MouseEvent, 'mousedown', { ...base, buttons: 1 });
    fire(window.PointerEvent || window.MouseEvent, 'pointerup', { ...ptr, buttons: 0 });
    fire(window.MouseEvent, 'mouseup', base);
    fire(window.MouseEvent, 'click', base);
    return true;
  }

  /** 找 header 右上角的「签到」图标（悬停提示 Check-in Rewards）。
   *  站点用 Radix Tooltip 包了一个 div：data-slot="tooltip-trigger" + size-8。
   *  备用策略：在 header 右侧容器里找"含 svg、class 有 size-8、不是 button/a"的 div。 */
  function findCheckinTrigger() {
    const direct = [...document.querySelectorAll(SEL.checkinTrigger)].find((e) => e.tagName === 'DIV');
    if (direct) return direct;
    const bars = [...document.querySelectorAll('header, [role="banner"]')];
    bars.push(document.body);
    for (const bar of bars) {
      const list = [...bar.querySelectorAll('div')];
      for (const d of list) {
        const cls = String(d.className);
        if (!/size-8/.test(cls)) continue;
        if (!/cursor-pointer|tooltip/i.test(cls)) continue;
        if (!d.querySelector('svg')) continue;
        if (/@/.test(textOf(d))) continue; // 别误点账号按钮
        return d;
      }
    }
    return null;
  }

  /** 主动点「签到」图标唤起签到面板。
   *  为什么需要：今日**已签到**的账号二次登录后，站点根本不自动弹窗，
   *  脚本只能干等 60s 才判"已签到"（用户实测：手动点一下立刻就有结果）。
   *  返回：唤起后的签到弹窗；打不开返回 null（调用方继续走原来的等待逻辑）。 */
  async function openCheckinPanel() {
    const el = findCheckinTrigger();
    if (!el) {
      log('未找到右上角「签到」图标 → 无法主动唤起');
      return null;
    }
    clickEl(el);
    let opened = await waitFor(() => getAnyDialog(), 2500, 300);
    if (!opened) {
      // 兜底：Radix 触发器有时只认完整指针序列
      clickMenuTrigger(el);
      opened = await waitFor(() => getAnyDialog(), 2500, 300);
    }
    if (!opened) return null;
    // 面板打开后等一帧让内容渲染完，再按"签到弹窗"的特征取一次
    return (await waitFor(() => getClaimDialog(), 1500, 300)) || getClaimDialog();
  }

  /** 填值并触发 input/change（React 受控输入必须用原生 setter）。 */  function setInputValue(el, value) {
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /* ------------------------------ 页面读取 ------------------------------- */

  /** 已登录邮箱；未登录返回 null。 */
  function getLoggedEmail() {
    const btns = document.querySelectorAll(SEL.accountTrigger);
    for (const b of btns) {
      const m = textOf(b).match(/[\w.+-]+@[\w.-]+\.\w+/);
      if (m) return m[0];
    }
    return null;
  }

  /** 取"coin 之后最近的、含数字的文本节点"里的第一个数字。
   *  只取单个文本节点，避免相邻 span 的文本被拼成一串（"32"+"30" → 3230）。 */
  function firstNumberAfter(node, root) {
    if (!root) return null;
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      walker.currentNode = node;
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        if (node.contains(t)) continue; // 跳过 coin 自身的文本
        const n = firstNumberIn(t.nodeValue);
        if (n !== null) return n;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /** 从一段文本里取第一个数字（支持千分位）；没有数字返回 null。 */
  function firstNumberIn(text) {
    const m = String(text || '').match(/\d[\d,\s]*/);
    if (!m) return null;
    const n = parseInt(m[0].replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  /** 读 header 积分；读不到返回 null。支持千分位。
   *  注意：0 分是合法值，调用方必须用 `=== null` 判断失败（不能用真值判断）。
   *  ⚠️ 旧版取整个 holder 的第一个数字，遇到数字排在前面的结构（角标、"2x bonus"）
   *  会读错，所以改为优先解析 coin 之后最近的文本节点。 */
  function readPoints() {
    const coins = [
      ...document.querySelectorAll(SEL.coinIcon),
      ...document.querySelectorAll('.p-icon--coin'),
    ];
    for (const coin of coins) {
      const parent = coin.parentElement;
      const holder = coin.closest('button') || parent;

      // 1) 优先：coin 之后最近的文本节点（积分数字通常就在这里）
      let near = firstNumberAfter(coin, parent || coin);

      // 2) 退一步：换成更大的容器（button），仍然只取 coin 之后的内容
      if (near === null && holder && holder !== parent) {
        near = firstNumberAfter(coin, holder);
      }

      // 3) 最后兜底：整个 holder 的第一个数字（旧行为）；与 1)/2) 不一致时以"紧邻文本"为准
      const loose = holder ? firstNumberIn(textOf(holder)) : null;
      if (near !== null) {
        if (loose !== null && loose !== near) {
          console.warn('[A2E] 积分取值不一致：紧邻文本=' + near + '，容器首个数字=' + loose + ' → 采用', near);
        }
        return near;
      }
      if (loose !== null) return loose;
    }
    return null;
  }

  /** 登录入口（未登录时 header 的登录按钮）。
   *  实测坑（两处）：
   *  1) 站点英文原文是 "Sign In"/"Sign-in"，用 \s* 匹配不到连字符 → 必须 [- ]?；
   *  2) 未登录时 header 里那颗按钮的 textContent 可能是 "Sign-in / Sign-up"
   *     这种合并文案，所以**不能用 ^...$ 全串锚定**，否则一条都匹配不到。 */
  const RE_LOGIN_ENTRY = [/sign[- ]?in/i, /log[- ]?in/i, /登录/, /登入/];
  const RE_REGISTER_ENTRY = [/sign[- ]?up/i, /注册/, /报名/];

  function findLoginEntry() {
    // 优先只在 header 里找，避免误点页面底部/CTA 区的 "Sign up" 链接
    const roots = [];
    const header = document.querySelector('header');
    if (header) roots.push(header);
    roots.push(document);

    for (const root of roots) {
      const nodes = root.querySelectorAll('button, [role="button"], a');
      // 第一轮：命中"登录"（"Sign-in / Sign-up" 合并文案也算，点开默认就是登录页签）
      for (const n of nodes) {
        const t = textOf(n);
        if (!t || t.length > 24) continue;
        if (RE_LOGIN_ENTRY.some((re) => re.test(t))) return n;
      }
      // 第二轮：只命中"注册"（它的表单同样是 username + password）
      for (const n of nodes) {
        const t = textOf(n);
        if (!t || t.length > 24) continue;
        if (RE_REGISTER_ENTRY.some((re) => re.test(t))) return n;
      }
    }
    return null;
  }

  /** 登录弹窗是否已打开。 */
  const loginModalOpen = () => !!document.querySelector(SEL.emailInput);

  /* ------------------------------ 弹窗判定 ------------------------------- */

  const RE_CLAIM_DIALOG = /每日奖励|Daily Reward|立即领取|Claim Now|签到|奖励已解锁/i;

  /** 取签到弹窗（含 Turnstile 容器或奖励文案的那个 dialog）。 */
  function getClaimDialog() {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    for (const d of dialogs) {
      if (d.querySelector(SEL.turnstileBox)) return d;
      if (RE_CLAIM_DIALOG.test(textOf(d))) return d;
    }
    return null;
  }

  /** 任意打开的 dialog（不限于签到弹窗）。
   *  为什么单独要一个：右上角「签到」图标唤起的**已领取状态**面板里没有
   *  「立即领取」文案，靠 RE_CLAIM_DIALOG 匹配不到，但有 Turnstile 容器；
   *  用"有没有 dialog" + "有没有主按钮"两步判断更稳。 */
  function getAnyDialog() {
    const d = document.querySelector('[role="dialog"]');
    return d || null;
  }

  /** 弹窗主按钮（data-variant=default 那个）；已领取状态下不存在。 */
  function getPrimaryButton(root) {
    if (!root) return null;
    const byVariant = root.querySelector(`button[data-slot="button"][data-variant="${SEL.dialogPrimaryVariant}"]`);
    if (byVariant) return byVariant;
    return findButtonByText([/claim now/i, /立即领取/, /领取/, /^claim$/i], root);
  }

  /** 今日已签到 / 已领取 相关文案。 */
  function isAlreadySigned(text) {
    const t = text || '';
    return [
      /今日已签到/, /已签到/, /已领取/, /明天再来/, /下次可申请理赔/,
      /already\s+(checked|claimed|signed)/i, /come\s+back\s+tomorrow/i,
      /already\s+received/i, /next\s+claim\s+available/i, /下次(领取|签到)/,
    ].some((re) => re.test(t));
  }

  /** 限制 / 频繁 / 上限 相关文案。 */
  function isSignInLimited(text) {
    const t = text || '';
    return [
      /操作?频繁/, /过于频繁/, /频繁/, /上限/, /已达上限/, /限制/, /稍后再试/,
      /请稍后/, /冷却/, /系统繁忙/, /验证失败/, /验证超时/,
      /too\s+many/i, /rate\s+limit/i, /try\s+again\s+later/i, /exceed/i,
      /limit\s+reached/i, /captcha/i, /verification\s+failed/i,
    ].some((re) => re.test(t));
  }

  function pageToastText() {
    const nodes = document.querySelectorAll(SEL.toast);
    return [...nodes].map(textOf).join(' ');
  }

  /* ---------------------- 状态读写（GM + localStorage 双写） ----------------------
   * 踩坑（第二轮实测）：`GM_setValue()` 是异步写盘的（要 postMessage 给扩展），
   * 写完立刻 `location.reload()` 会把这次写入一起吞掉。
   * 后果：签到成功后"索引推进"没落盘 → 刷新后仍是同一个账号 →
   *       脚本无限重复登录该账号，永远不切下一个。
   * 反证：重试计数每次写完都 sleep 了 2.5~4 秒再刷新，所以它一直是对的。
   * 对策：GM + localStorage 双写（localStorage 是同步的，reload 也带得走），
   *       读取时优先 localStorage，GM 作后备；刷新前再留 800ms 落盘时间。
   * ------------------------------------------------------------------------ */
  const LS_PREFIX = 'a2e_sync:';
  const K_NEXT = 'a2e_next_email';   // 交接：下一个待处理账号（索引丢失时用来纠正）

  function stateGet(key, dflt) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      if (raw !== null) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    try { return GM_getValue(key, dflt); } catch (e) { return dflt; }
  }

  function stateSet(key, val) {
    try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(val)); } catch (e) { /* ignore */ }
    try { GM_setValue(key, val); } catch (e) { /* ignore */ }
  }

  /** 平台的"每日"不是零点刷新，而是 **早上 08:00** 刷新
   *  （实测：已签到弹窗显示 "Next claim available at 10/20/2026 08:00"）。
   *  所以任务日的 key 取 (现在 - 8h) 的本地日期：
   *  凌晨 00:00~07:59 仍算"前一天"，避免 8 点前跑完、8 点后误判"今日已完成"。 */
  function todayStr() {
    const DAY_START_HOUR = 8; // 与站点刷新时间保持一致
    const d = new Date(Date.now() - DAY_START_HOUR * 3600 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** 判断 a 是不是 b 的前一个任务日（用于"跨 08:00 的上一轮"只认昨天）。 */
  function isPrevTaskDay(a, b) {
    const pa = Date.parse(a + 'T00:00:00Z');
    const pb = Date.parse(b + 'T00:00:00Z');
    return Number.isFinite(pa) && Number.isFinite(pb) && (pb - pa) === 86400000;
  }

  /** 本轮运行归属的任务日（固定值，不随页面刷新改变）。
   *  解决：07:59 开跑、08:01 还没跑完时，每次 reload 重新取 todayStr() 会拿到新日期，
   *  旧日尾段把新一天的账号先消耗掉，剩下的账号又被标成"新一天已完成" → 新一天漏签。
   *  规则：上一轮确实跑完了（K_DONE_DATE === K_RUN_DATE）才允许切到新任务日；
   *        否则沿用已固定的 K_RUN_DATE，本轮绝不中途切换。
   *  安全阀：只认"今天或昨天"的固定值，更旧说明这轮早废了（跑一半被关掉等），重新定日。 */
  function runDate() {
    const today = todayStr();
    const run = stateGet(K_RUN_DATE, '') || '';
    const doneDate = stateGet(K_DONE_DATE, '') || '';
    if (!run || (run !== today && (doneDate === run || !isPrevTaskDay(run, today)))) {
      if (run !== today) stateSet(K_RUN_DATE, today);
      return today;
    }
    return run;
  }

  function log(msg) {
    const line = `[${new Date().toLocaleString()}] ${msg}`;
    const arr = stateGet(K_LOG, []);
    arr.push(line);
    while (arr.length > 300) arr.shift();
    stateSet(K_LOG, arr);
    console.log('[A2E]', msg);
  }

  const retryOf = (email) => stateGet(K_RETRY + email, 0) | 0;
  const setRetry = (email, n) => stateSet(K_RETRY + email, n | 0);
  const clearRetry = (email) => stateSet(K_RETRY + email, 0);
  // "读不到积分"单独一套计数：避免和超时/限制类重试互相消耗配额
  const retryPointsOf = (email) => stateGet(K_RETRY_POINTS + email, 0) | 0;
  const setRetryPoints = (email, n) => stateSet(K_RETRY_POINTS + email, n | 0);
  const clearRetryPoints = (email) => stateSet(K_RETRY_POINTS + email, 0);

  /** 今日已处理完（成功领取 or 判定已签到）的账号集合。
   *  用途：旧版只看"当前登录账号在不在列表里"就纠正索引重跑一遍，已签到的账号
   *  每轮都被拉回来 → 与"交接账号纠正索引"对冲成 35s 一轮的无限刷新（第五轮实测）。 */
  const doneSet = () => {
    const s = stateGet(K_DONE_SET, null);
    return (s && s.date === runDate() && Array.isArray(s.emails)) ? s.emails : [];
  };
  const isDoneToday = (email) => {
    const e = String(email || '').toLowerCase();
    return !!e && doneSet().some((x) => String(x).toLowerCase() === e);
  };
  function markDoneToday(email) {
    const e = String(email || '');
    if (!e) return;
    const base = doneSet().slice();
    if (!base.some((x) => String(x).toLowerCase() === e.toLowerCase())) base.push(e);
    stateSet(K_DONE_SET, { date: runDate(), emails: base });
  }

  function notify(text, title = 'A2E 每日签到') {
    try { GM_notification({ title, text, timeout: 8000 }); } catch (e) { /* ignore */ }
  }

  /* ----------------------- 单例锁（防同浏览器双跑） ----------------------- */

  const LOCK_SID = 'a2e_lock_id'; // 本标签的锁身份（sessionStorage：刷新不变、关标签即失效）
  let lockId = '';
  let lockTimer = null;

  function lockRead() {
    try { return JSON.parse(localStorage.getItem(LS_PREFIX + K_LOCK) || 'null'); } catch (e) { return null; }
  }
  function lockWrite(at) {
    try { localStorage.setItem(LS_PREFIX + K_LOCK, JSON.stringify({ id: lockId, at })); } catch (e) { /* ignore */ }
  }

  /** 抢锁：解决"开两个标签同时跑，互抢登录/退出、索引来回跳"。
   *  只做同浏览器互斥（localStorage 心跳），不做跨设备互斥。 */
  function acquireSingletonLock() {
    if (!lockId) {
      try { lockId = sessionStorage.getItem(LOCK_SID) || ''; } catch (e) { /* ignore */ }
      if (!lockId) {
        lockId = (window.crypto && crypto.randomUUID)
          ? crypto.randomUUID()
          : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
        try { sessionStorage.setItem(LOCK_SID, lockId); } catch (e) { /* ignore */ }
      }
    }
    const cur = lockRead();
    if (cur && cur.id && cur.id !== lockId && (Date.now() - (cur.at || 0)) < LOCK_TTL) return false;
    lockWrite(Date.now());
    return true;
  }

  /** 续期：锁已被别的活标签占用时不写，避免抢别人的锁。 */
  function renewSingletonLock() {
    const cur = lockRead();
    if (cur && cur.id && cur.id !== lockId && (Date.now() - (cur.at || 0)) < LOCK_TTL) return;
    lockWrite(Date.now());
  }

  function startSingletonHeartbeat() {
    if (lockTimer) return;
    lockTimer = setInterval(renewSingletonLock, LOCK_RENEW);
  }

  /** 释放：只在锁的 id 确实是自己时才删，避免误删别人的锁。 */
  function releaseSingletonLock() {
    if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }
    const cur = lockRead();
    if (cur && lockId && cur.id === lockId) {
      try { localStorage.removeItem(LS_PREFIX + K_LOCK); } catch (e) { /* ignore */ }
    }
  }

  // 关标签/刷新时主动放锁：新标签可以立刻接管，不用干等 90s 过期
  addEventListener('pagehide', () => { releaseSingletonLock(); });

  /** 防刷新风暴：10 分钟窗口内最多 80 次重载。 */
  function guardOk() {
    const now = Date.now();
    const g = stateGet(K_GUARD, { t: 0, n: 0 });
    if (!g || !g.t || now - g.t > 10 * 60 * 1000) {
      stateSet(K_GUARD, { t: now, n: 1 });
      return true;
    }
    if (g.n > 80) return false;
    stateSet(K_GUARD, { t: g.t, n: g.n + 1 });
    return true;
  }

  /** 只推进索引（落盘），不刷新。供"退出登录前"使用。 */
  function planNext(reason) {
    const list = accountsGet();
    const i = (stateGet(K_INDEX, 0) | 0) + 1;
    stateSet(K_INDEX, i);
    // 交接下一个账号：即使索引没落盘，刷新后也能靠它纠正
    stateSet(K_NEXT, i < list.length ? emailOf(list[i]) : '');
    stateSet(K_CHECKIN, null);
    const nextMsg = i < list.length ? `，下一个是 ${emailOf(list[i])}` : '，已是最后一个';
    log(`索引推进 → ${Math.min(i + 1, list.length)}/${list.length}${reason ? '（' + reason + '）' : ''}${nextMsg}（今日已完成 ${todayDoneCount()}/${list.length}）`);
    return i;
  }

  /** 推进索引并刷新，进入下一轮（每次页面加载只处理一个账号）。 */
  function advanceIndex(reason) {
    planNext(reason);
    // 留 800ms 落盘（GM_setValue 异步，立刻 reload 会丢写入）
    setTimeout(() => location.reload(), 800);
  }

  function finishAll() {
    const rd = runDate(); // 本轮固定的任务日（跨 08:00 时不写错日期）
    const list = accountsGet();
    const done = todayDoneCount();
    stateSet(K_DONE_DATE, rd);
    stateSet(K_RUN_DATE, null); // 本轮结束，允许下一次加载开新任务日
    stateSet(K_INDEX, 0);
    stateSet(K_NEXT, '');
    stateSet(K_CHECKIN, null);
    // 注意：这里**不再清空** K_DONE_SET —— 它是"今日已完成 x/y"的数据来源，
    // 清掉会让面板在跑完后显示 0/15。done_set 自带任务日，跨日自动失效。
    const msg = `${rd} 的账号处理完毕：今日已完成 ${done}/${list.length}`
      + (done < list.length ? `（${list.length - done} 个未完成，可在面板点「开始 / 继续轮询」重试）` : '');
    log(msg);
    notify(msg);
    releaseSingletonLock();
    refreshPanel();
  }

  /* ============================ 核心动作 ============================ */

  /** 打开登录弹窗：最多重试 15 秒，一步步把失败原因写进日志。
   *  实测失败原因：页面水合慢时 header 里还没有 "Sign In" 按钮，
   *  旧版直接放弃 → 报"打不开登录弹窗"。现在改为持续等待 + 多路兜底。 */
  async function openLoginModal() {
    if (loginModalOpen()) return true;

    const deadline = Date.now() + 15000;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;

      // 1) 正常入口
      const btn = findLoginEntry();
      if (btn) {
        const label = textOf(btn).slice(0, 20);
        clickEl(btn);
        if (await waitFor(loginModalOpen, 2500, 150)) {
          log(`登录弹窗已打开（点击「${label}」，第 ${attempt} 次尝试）`);
          return true;
        }
      }

      // 2) 兜底：header 里排除主题/语言后的最后一个按钮
      if (attempt % 2 === 0) {
        const hb = [...document.querySelectorAll('header button')]
          .filter((b) => !/theme|主题|English|🇺🇸/i.test(textOf(b)) && textOf(b).length <= 24);
        const last = hb[hb.length - 1];
        if (last) {
          clickEl(last);
          if (await waitFor(loginModalOpen, 2000, 150)) {
            log(`登录弹窗已打开（兜底 header 按钮「${textOf(last).slice(0, 20)}」）`);
            return true;
          }
        }
      }

      // 3) 兜底：点"生成"，未登录会被拦到登录弹窗
      if (attempt % 3 === 0) {
        const gen = findButtonByText([/^generate/i, /^产生/, /生成/]);
        if (gen) {
          clickEl(gen);
          if (await waitFor(loginModalOpen, 2500, 150)) {
            log('登录弹窗已打开（点击「Generate」触发）');
            return true;
          }
        }
      }

      await sleep(500);
    }

    log(`打开登录弹窗失败：header 按钮 = [${[...document.querySelectorAll('header button')].map((b) => textOf(b).slice(0, 12)).join(' | ')}]，登录入口=${findLoginEntry() ? '有' : '无'}`);
    return false;
  }

  /** 登录指定账号（account = {email, password}）。成功时页面通常会整页刷新（本函数可能不返回）。 */
  async function doLogin(account) {
    const email = emailOf(account);
    const password = String((account && account.password) || '');
    if (!email) return { ok: false, reason: '账号邮箱为空' };
    if (!password) return { ok: false, reason: '该账号未设置密码（请到面板补录）' };
    if (!(await openLoginModal())) return { ok: false, reason: '打不开登录弹窗' };

    // 保证在"Sign In / 登入"页签（不是 Sign Up / 报名）
    // 实测英文原文："Sign In" / "Sign Up"（带空格或连字符，不能只用 \s*）
    const tabs = [...document.querySelectorAll('[role="dialog"] button[data-slot="tabs-trigger"]')];
    if (tabs.length) {
      const signInTab = tabs.find((t) => /^\s*(sign|log)[- ]?in\s*$/i.test(textOf(t)))
        || tabs.find((t) => /登录|登入/.test(textOf(t)));
      if (signInTab && signInTab.getAttribute('data-state') !== 'active') {
        clickEl(signInTab);
        log('已切换到「Sign In」页签');
        await sleep(400);
      }
    }

    const em = await waitFor(() => document.querySelector(SEL.emailInput), 8000);
    const pw = await waitFor(() => document.querySelector(SEL.passwordInput), 8000);
    if (!em || !pw) return { ok: false, reason: '未找到邮箱/密码输入框' };

    // 切账号关键一步：先把上一轮的残留值 / 浏览器自动填充清干净，
    // 否则弹窗里会一直挂着上一个账号，看起来像"没切换账号"。
    em.setAttribute('autocomplete', 'off');
    pw.setAttribute('autocomplete', 'new-password');
    em.focus(); setInputValue(em, '');
    pw.focus(); setInputValue(pw, '');
    await sleep(200);

    log(`填写登录表单：${email}`);
    em.focus(); setInputValue(em, email); await sleep(200);
    pw.focus(); setInputValue(pw, password); await sleep(200);

    // 校验：Chrome 自动填充可能把我们写的邮箱覆盖回去，值不对就再写一遍
    for (let i = 0; i < 3 && String(em.value || '').toLowerCase() !== email.toLowerCase(); i++) {
      log(`邮箱框残留「${String(em.value || '').slice(0, 40)}」→ 覆盖为 ${email}`);
      setInputValue(em, email);
      await sleep(250);
    }
    if (String(em.value || '').toLowerCase() !== email.toLowerCase()) {
      return { ok: false, reason: '邮箱框填不进去（被自动填充覆盖）' };
    }

    const submit = getPrimaryButton(document.querySelector('[role="dialog"]'));
    if (!submit) return { ok: false, reason: '未找到登录按钮' };

    clickEl(submit);
    log(`已提交登录：${email}`);

    // ⚠️ 关键修复（第三轮实测）：站点登录成功会**整页刷新**，刷新后的 header
    // 会先渲染出「Sign-in / Sign-up」几秒，等水合完才换上账号按钮。
    // 旧逻辑在刷新后 1s 就把"有登录入口"当成"未登录"→ 又提交一次 →
    // 站点再刷新 → 无限"登录→退出→再登录同一个账号"。
    // 对策①：落一个"刚提交登录"的标记，让下一次加载先等会话落地，不要重复提交。
    const prevPend = stateGet(K_PEND, null);
    stateSet(K_PEND, {
      email,
      at: Date.now(),
      tries: ((prevPend && prevPend.email === email && prevPend.tries) ? prevPend.tries : 0) + 1,
    });
    // 对策②：重新登录这个账号时，签到等待计时必须归零。
    // 否则会拿上一轮（失败重试期间）累计的时间直接判"今日已签到" →
    // 刚登录就立刻退出（用户实测的"登录后立即退出"就是这个）。
    stateSet(K_CHECKIN, null);

    // 成功会整页刷新；这里等账号按钮出现（SPA 未刷新时也能继续）
    const got = await waitFor(() => getLoggedEmail(), 25000, 500);
    if (got && got.toLowerCase() === email.toLowerCase()) { stateSet(K_PEND, null); return { ok: true }; }
    const errText = textOf(document.querySelector('[role="dialog"]') || document.body).slice(0, 120);
    return { ok: false, reason: '登录未成功' + (errText ? '：' + errText : '') };
  }

  /** 直接删掉站点登录 cookie。
   *  ⚠️ 第六轮实测（关键）：站点的「Log out」**不发任何接口请求**（network 里没有任何
   *  logout/auth 请求），它只是在客户端把 `token` cookie 删掉（登录态就是这一个
   *  非 HttpOnly cookie，`document.cookie` 里能看到 `token=...`）。
   *  所以不用去点 Radix 菜单——直接删 cookie 更快更稳，也不受 TM 沙箱合成事件影响。
   *  实测：删完 cookie 后刷新即变未登录，脚本立刻能接着登下一个账号。 */
  function clearAuthCookies() {
    const names = ['token', 'access_token', 'auth_token', 'session', 'jwt'];
    const host = location.hostname;
    const domains = ['', host, '.' + host];
    const parts = host.split('.');
    if (parts.length >= 2) domains.push('.' + parts.slice(-2).join('.'));
    let cleared = 0;
    for (const nm of names) {
      const re = new RegExp('(^|;\\s*)' + nm + '=');
      if (!re.test(document.cookie)) continue;
      for (const dm of domains) {
        try {
          document.cookie = nm + '=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
            + (dm ? '; domain=' + dm : '');
          cleared++;
        } catch (e) { /* ignore */ }
      }
    }
    return cleared;
  }

  /** 退出登录。首选直删 cookie（第六轮实测），菜单路径仅作兜底。 */
  async function doLogout() {
    // 遮罩会吃掉 header 的点击 → 先清掉任何打开的弹窗
    await closeAnyDialog();
    if (!getLoggedEmail()) { clearAuthCookies(); return true; }

    // ===== 首选：直接删 token cookie =====
    const cleared = clearAuthCookies();
    await sleep(250);
    if (!getLoggedEmail()) return true;
    if (cleared > 0 && !/(^|;\s*)token=/.test(document.cookie)) {
      // 落一个"刚退出"标记：下一次加载已验证 token 不存在，可直接跳过 8s 水合等待，
      // 不必再等 header 连续 1.5s 稳定显示登录入口（每个账号省 ~8-10s）。
      stateSet(K_LOUT, Date.now());
      log('已清除登录 cookie（刷新后生效）');
      return true; // 交给调用方 reload 验证
    }

    // ===== 兜底：点 Radix 菜单（只试 2 次，避免卡 30s+）=====
    for (let i = 0; i < 2; i++) {
      if (!getLoggedEmail()) return true;

      if (document.querySelector('[role="dialog"]')) await closeAnyDialog();

      const acc = [...document.querySelectorAll(SEL.accountTrigger)].find((b) => /@/.test(textOf(b)));
      if (!acc) break;
      clickMenuTrigger(acc);

      const items = await waitFor(() => {
        const list = [...document.querySelectorAll(SEL.menuItem)];
        return list.length ? list : null;
      }, 4000, 200);

      if (items && items.length) {
        const out = items.find((x) => /log\s*out|退出|登出/i.test(textOf(x))) || items[items.length - 1];
        clickEl(out);
        const gone = await waitFor(() => !getLoggedEmail(), 15000, 400);
        if (gone) return true;
      }
      await sleep(1500);
    }
    return !getLoggedEmail();
  }

  /** 关掉挡住的弹窗（领取成功后弹窗有时会停留一会儿）。 */
  async function closeDialogs() {
    const d = getClaimDialog();
    if (!d) return;
    const btn = d.querySelector(SEL.dialogClose) || findButtonByText([/close/i, /关闭/], d);
    if (btn) clickEl(btn);
    await sleep(600);
  }

  /** 关掉任何挡在页面上的弹窗（登录弹窗 / 签到弹窗）。
   *  ⚠️ 实测坑（第四轮）：签到弹窗「Daily Bonus Unlocked!」打开时，
   *  它的遮罩会盖住 header，点账号按钮完全没反应 → 脚本卡在
   *  "当前登录 A，目标是 B → 先退出" 里无限循环。退出前必须先清弹窗。
   */
  async function closeAnyDialog() {
    for (let i = 0; i < 3; i++) {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return true;
      const btn = d.querySelector(SEL.dialogClose)
        || findButtonByText([/^close$/i, /^关闭$/, /no,?\s*thanks/i, /不，?谢谢/], d);
      if (btn) {
        clickEl(btn);
        await sleep(500);
        continue;
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(500);
    }
    return !document.querySelector('[role="dialog"]');
  }

  /** 检测是否出现需要人工处理的人机验证。 */
  function turnstileNeedsHuman() {
    const box = document.querySelector(SEL.turnstileBox);
    if (!box) return false;
    const ifr = box.querySelector(SEL.turnstileIframe) || document.querySelector(SEL.turnstileIframe);
    if (!ifr) return false;
    const r = ifr.getBoundingClientRect();
    return r.width > 60 && r.height > 40; // 可见的交互式挑战
  }

  /* ============================ 签到主流程 ============================ */

  /** 已登录为目标账号后的签到处理。 */
  async function handleCheckIn(email) {
    const p0 = await waitForValue(() => readPoints(), 30000, 400);
    if (p0 === null) {
      // 读不到积分 ≠ 账号有问题（页面水合慢/网络抖动）。直接跳过会漏签且不回头补，
      // 所以改成"刷新重试"，计数独立于超时/限制类重试（K_RETRY_POINTS），互不消耗配额。
      const n = retryPointsOf(email) + 1;
      setRetryPoints(email, n);
      if (n <= MAX_RETRY_POINTS) {
        log(`${email} 读不到积分，刷新后重试 (${n}/${MAX_RETRY_POINTS})`);
        await sleep(3000);
        location.reload();
      } else {
        log(`${email} 读不到积分重试已用尽 (${MAX_RETRY_POINTS}/${MAX_RETRY_POINTS}) → 跳过该账号`);
        clearRetryPoints(email);
        // 不调 finishAccount（那会退出登录，读不到积分时没意义，白跑一轮登录）
        advanceIndex('读不到积分重试用尽');
      }
      return;
    }
    clearRetryPoints(email);
    log(`开始 ${email}，签到前积分 ${p0}`);

    // 1) 等签到弹窗（已领取的账号站点不会弹窗）
    //    ⚠️ 站点在登录/登出后经常自己整页跳转（实测 2s、20s 各跳一次），
    //    单次 45s 的 in-page 等待会被跳转直接打断 → 改成"跨刷新累计计时"。
    let st = stateGet(K_CHECKIN, null);
    if (!st || st.email !== email || !st.at || (Date.now() - st.at) > 10 * 60 * 1000) {
      st = { email, at: Date.now() };
      stateSet(K_CHECKIN, st);
    }
    const elapsed = Date.now() - st.at;
    if (elapsed >= T.claimDialog) {
      log(`${email} 累计等待 ${Math.round(elapsed / 1000)}s 仍无签到弹窗 → 判定今日已签到`);
      await finishAccount(email, '已签到', p0, p0);
      return;
    }
    const slice = Math.max(3000, Math.min(T.claimSlice, T.claimDialog - elapsed));
    log(`等待签到弹窗：本轮最多 ${Math.round(slice / 1000)}s（累计已等 ${Math.round(elapsed / 1000)}s / 上限 ${T.claimDialog / 1000}s）`);

    // 1a) 先短暂观察：未签到的账号登录后一般 1~3s 自己弹窗
    const probe = Math.min(slice, T.claimProbe);
    let dlg = await waitFor(getClaimDialog, probe, 400);

    // 1b) 没弹窗 → 主动点右上角「签到」图标问一次。
    //     ⚠️ 这是"今日已签到"账号唯一的探路方式：站点对它们根本不自动弹窗，
    //     旧版只能干等满 60s 才判"已签到"（用户实测手动点一下 1s 就有结果）。
    if (!dlg) {
      log(`${email} 未见自动弹窗 → 点击右上角「签到」图标主动唤起`);
      dlg = await openCheckinPanel();
      if (dlg) log('已主动唤起签到面板');
    }

    // 1c) 还是没有 → 把本轮剩下的时间等满（自动弹窗偶尔会晚到）
    const rest = slice - probe;
    if (!dlg && rest > 2000) dlg = await waitFor(getClaimDialog, rest, 500);

    if (!dlg) {
      const total = Date.now() - st.at;
      log(`${email} 本轮仍无弹窗（累计 ${Math.round(total / 1000)}s）→ 刷新后继续等`);
      setTimeout(() => location.reload(), 400);
      return;
    }

    // 2) 弹窗已是"已领取"状态（只有升级/关闭按钮）
    if (!getPrimaryButton(dlg)) {
      log(`${email} 弹窗为已领取状态 → 今日已签到`);
      await finishAccount(email, '已签到', p0, p0);
      return;
    }

    // 3) 点"立即领取"
    let success = false;
    let p1 = p0;
    for (let attempt = 1; attempt <= T.maxClaimClicks; attempt++) {
      const cur = getClaimDialog();
      const btn = cur && getPrimaryButton(cur);
      if (!btn) break; // 弹窗状态变了（可能已领取）

      clickEl(btn);
      log(`点击「立即领取」(${attempt}/${T.maxClaimClicks})`);

      const res = await waitFor(() => {
        const now = readPoints();
        if (now !== null && now > p0) return { ok: true, points: now };
        const d = getClaimDialog();
        if (!d) return { ok: true, points: readPoints() };
        if (!getPrimaryButton(d)) return { ok: true, points: readPoints() };
        if (turnstileNeedsHuman()) return { human: true };
        return null;
      }, T.pointsIncrease, T.pollStep);

      if (res && res.human) {
        log('检测到可见的人机验证 → 需要手动完成');
        notify('签到弹窗弹出人机验证，请到浏览器手动完成验证');
        // 给用户 3 分钟处理
        await waitFor(() => {
          const now = readPoints();
          return (now !== null && now > p0) ? { ok: true } : null;
        }, 180000, 2000);
      }

      const after = readPoints();
      if (after !== null && after > p0) {
        success = true; p1 = after; break;
      }
      const d2 = getClaimDialog();
      if (!d2 || !getPrimaryButton(d2)) {
        const ap = readPoints();
        if (ap !== null && ap > p0) { success = true; p1 = ap; }
        else { success = false; p1 = ap === null ? p0 : ap; }
        break;
      }
      await sleep(3000);
    }

    // 4) 结果判定
    if (success && p1 > p0) {
      log(`签到成功：${email} ${p0} → ${p1} (+${p1 - p0})`);
      await finishAccount(email, '成功', p0, p1);
      return;
    }

    // 没涨分：区分"已签到""限制""超时"
    const d3 = getClaimDialog();
    const allText = textOf(document.body) + ' ' + pageToastText();
    if ((d3 && !getPrimaryButton(d3)) || isAlreadySigned(allText)) {
      log(`${email} 判定为今日已签到（积分未变化 ${p0}）`);
      await finishAccount(email, '已签到', p0, p0);
      return;
    }

    const n = retryOf(email) + 1;
    setRetry(email, n);

    if (isSignInLimited(allText)) {
      log(`检测到限制/频繁/上限提示 (${n}/${MAX_RETRY_LIMIT})：不退出、不前进，刷新后重试`);
      if (n >= MAX_RETRY_LIMIT) {
        log(`${email} 限制类重试已用尽 → 跳过`);
        clearRetry(email);
        await closeDialogs();
        advanceIndex('限制重试用尽');
      } else {
        await sleep(4000);
        location.reload();
      }
      return;
    }

    log(`签到超时且无明确文案 (${n}/${MAX_RETRY_TIMEOUT})：不退出、不前进`);
    if (n >= MAX_RETRY_TIMEOUT) {
      log(`${email} 超时重试已用尽 → 跳过`);
      clearRetry(email);
      await closeDialogs();
      advanceIndex('超时重试用尽');
    } else {
      await sleep(3000);
      location.reload();
    }
  }

  /** 收尾：关弹窗 → 先推进索引 → 再退出 → 刷新。
   *  ⚠️ 顺序很关键：站点点「Log out」后会**自己整页跳转**，
   *  跳转会立刻杀掉当前 JS 上下文 —— 写在"退出之后"的索引永远执行不到，
   *  实测表现就是：退出成功 → 刷新 → 又是同一个账号（永远卡在第一个账号）。
   *  所以索引必须在点退出**之前**落盘。 */
  async function finishAccount(email, kind, p0, p1) {
    // 提速：退出已改成"删 cookie"，不再需要点 header 菜单，弹窗遮罩拦不住；
    // 原来这里先 closeDialogs() 再等 600ms 纯属浪费，直接推进索引+退出。
    clearRetry(email);
    if (kind === '成功' || kind === '已签到') markDoneToday(email);
    planNext(kind);
    const out = await doLogout();
    log(out
      ? `${email} 已退出登录`
      : `${email} 退出登录未确认（索引已推进，下轮会先把旧账号退掉）`);
    // 留 800ms 落盘：GM_setValue 是异步的，立刻 reload 会丢写入（索引丢了会重复跑同一账号）
    setTimeout(() => location.reload(), 800);
  }

  /* =============================== 主流程 =============================== */

  /** 判断"到底有没有登录"，要顶得住水合期 header 先渲染登录入口的假象。
   *  - 出现账号按钮（邮箱）→ 立刻算已登录；
   *  - 要判"未登录"，必须满足：页龄 > T.authSettle、仍只有登录入口、
   *    且连续两次采样（间隔 T.stableFor）结论一致；
   *  - 兜底：等满 T.loginSettle 还没账号按钮 → 按未登录处理。
   */
  async function waitForAuthSettled() {
    const start = Date.now();
    let stableAt = 0;
    for (;;) {
      const email = getLoggedEmail();
      if (email) return email;

      const age = Date.now() - start;
      if (age >= T.authSettle && findLoginEntry()) {
        if (!stableAt) stableAt = Date.now();
        else if (Date.now() - stableAt >= T.stableFor) {
          log(`header 连续 ${Math.round(T.stableFor / 1000)}s 稳定显示登录入口（页龄 ${Math.round(age / 1000)}s）→ 判定未登录`);
          return null;
        }
      } else {
        stableAt = 0;
      }

      if (age >= T.loginSettle) {
        log(`等待 ${Math.round(age / 1000)}s 仍未见账号按钮 → 按未登录处理`);
        return getLoggedEmail();
      }
      await sleep(400);
    }
  }

  async function main() {
    // 单例锁必须最先抢：两个标签同时跑会互抢登录/退出，索引来回跳
    if (!acquireSingletonLock()) {
      console.log('[A2E] 已有其他标签在运行，本标签跳过');
      return;
    }
    startSingletonHeartbeat();

    const today = runDate(); // 本轮固定的任务日（不是"现在"的任务日）

    // 今日已完成
    if (stateGet(K_DONE_DATE, '') === today) { releaseSingletonLock(); return; }

    if (!guardOk()) {
      log('10 分钟内重载次数过多，停止（可能是选择器失效或站点异常）');
      releaseSingletonLock();
      return;
    }

    const list = accountsGet();
    if (!list.length) {
      log('账号列表为空 → 请在页面左下角「A2E 签到」面板中添加账号（邮箱 + 密码）');
      openPanel();
      releaseSingletonLock();
      return;
    }

    let idx = stateGet(K_INDEX, 0) | 0;

    // 兜底：如果索引没落盘（旧版并发症），用"下一个账号"交接值纠正
    const handoff = stateGet(K_NEXT, '');
    if (handoff) {
      const hi = list.findIndex((e) => e.email.toLowerCase() === String(handoff).toLowerCase());
      if (hi > idx) {
        log(`索引 ${idx + 1} 落后于交接账号 ${handoff} → 纠正为 ${hi + 1}`);
        idx = hi;
        stateSet(K_INDEX, idx);
      }
    }

    if (idx >= list.length) { finishAll(); return; }

    const target = list[idx];
    const email = emailOf(target);
    log(`索引 ${idx + 1}/${list.length} → 目标账号 ${email}`);

    // 今日已完成 → 直接跳过，不再白跑一次登录/退出。
    // 触发场景：面板里增删/排序账号后索引被重算，或旧版索引漂移。
    if (isDoneToday(email)) {
      const cur = String(getLoggedEmail() || '').toLowerCase();
      const progress = `今日已完成 ${todayDoneCount()}/${list.length}`;
      if (cur && cur === email.toLowerCase()) {
        log(`${email} 今日已完成 → 先退出，再继续（${progress}）`);
        planNext('今日已完成，跳过');
        await doLogout();
        setTimeout(() => location.reload(), 800);
      } else {
        log(`${email} 今日已完成，跳过（${progress}）`);
        advanceIndex('今日已完成，跳过');
      }
      return;
    }

    let logged = null;

    // ===== A. 上一次加载刚提交过登录 → 先等会话落地，绝不重复提交 =====
    // 站点登录成功会整页刷新，刷新后 header 先渲染 Sign-in 几秒。
    // 不做这一步就会"重复登录同一个账号"（第三轮实测的死循环）。
    const pend = stateGet(K_PEND, null);
    const pendFresh = !!(pend && pend.email && (Date.now() - (pend.at || 0)) < 6 * 60 * 1000
      && String(pend.email).toLowerCase() === email.toLowerCase());
    if (pendFresh) {
      const waited = Math.round((Date.now() - pend.at) / 1000);
      log(`检测到 ${waited}s 前提交的登录（${pend.email}）→ 等会话落地，不重复提交`);
      logged = await waitFor(() => getLoggedEmail(), T.loginSettle, 500);
      stateSet(K_PEND, null);

      if (!logged) {
        const n = Math.max(pend.tries | 0, retryOf(email) + 1);
        setRetry(email, n);
        log(`登录失败 (${n}/${MAX_RETRY_LOGIN})：${Math.round(T.loginSettle / 1000)}s 内 header 没出现账号按钮`);
        if (n >= MAX_RETRY_LOGIN) {
          log(`连续登录失败 ${MAX_RETRY_LOGIN} 次 → 停止本轮（不跳过账号，等你处理）`);
          notify(`登录 ${email} 连续失败 ${MAX_RETRY_LOGIN} 次，已停止，请检查密码或站点状态`);
          clearRetry(email);
          releaseSingletonLock();
        } else {
          await sleep(3000);
          location.reload();
        }
        return;
      }
      log(`登录成功：${logged}（提交后 ${Math.round((Date.now() - pend.at) / 1000)}s 出现账号按钮）`);
    }

    // ===== B. 没有待确认的登录 → 等 header 水合稳定后再下"未登录"结论 =====
    // ⚠️ 提速（第六轮后）：如果上一次加载刚把 token cookie 删掉，这一轮从 cookie 就能
    // 确认"必然未登录"，不必再等页龄 8s + 连续 1.5s 采样（每账号省 ~8-10s）。
    if (!logged) {
      const lout = stateGet(K_LOUT, 0) | 0;
      const tokenGone = !/(^|;\s*)token=/.test(document.cookie);
      if (lout && tokenGone && (Date.now() - lout) < 3 * 60 * 1000) {
        log(`刚退出登录 ${Math.round((Date.now() - lout) / 1000)}s 前且 token cookie 确已清空 → 跳过水合等待，直接登录`);
        stateSet(K_LOUT, null);
      } else {
        logged = await waitForAuthSettled();
      }
    }

    // 登录的是别的账号
    if (logged && logged.toLowerCase() !== email.toLowerCase()) {
      // ⚠️ 整改（第四轮实测）：如果当前登录的账号本来就在列表里，说明索引漂了
      // （前面某轮"读不到积分"跳过了它，人却还登着）。此时**不要退出**——
      // 退出会把已经弹出来的签到弹窗白白关掉，还要多跑一次登录。
      // 正确做法：把索引纠正到这个账号，先把它的奖励领了再往下走。
      const li = list.findIndex((e) => e.email.toLowerCase() === logged.toLowerCase());
      if (li >= 0) {
        // ⚠️ 第五轮实测死循环根因：已处理完的账号还登着（退出失败 or 刚落盘），这里又
        // "纠正索引先处理它"把 idx 拉回去，刷新后"交接账号"再拉回来，两边对冲 →
        // 每 35s 一轮无限刷新。所以今日已完成的账号绝不再重跑，直接退出往下走。
        if (isDoneToday(logged)) {
          log(`当前登录 ${logged} 今日已完成 → 先退出，再继续 ${email}`);
          const out0 = await doLogout();
          log(out0 ? '已退出登录' : '退出未确认，刷新重试');
          await sleep(300);
          location.reload();
          return;
        }
        log(`当前登录 ${logged}（列表第 ${li + 1} 位 ≠ 索引 ${idx + 1}）→ 纠正索引，先处理这个账号`);
        stateSet(K_INDEX, li);
        // 注意：不要在这里清 K_CHECKIN —— 清了会让"累计 60s 判今日已签到"永远到不了，
        // 每轮只等 30s 就刷新，变成刷新风暴（第五轮实测）。
        await handleCheckIn(logged);
        return;
      }

      log(`当前登录 ${logged}（不在账号列表），目标是 ${email} → 先退出`);
      const out = await doLogout();
      log(out ? '已退出登录' : '退出未确认，刷新重试');
      await sleep(300);
      location.reload();
      return;
    }

    // 未登录 → 登录目标账号
    if (!logged) {
      log(`未登录，开始登录 ${email}（${idx + 1}/${list.length}）`);
      const r = await doLogin(target);
      if (!r.ok) {
        // 兜底：登录接口没确认成功，但页面其实已经登进去了（水合慢/刷新滞后）
        const maybe = getLoggedEmail();
        if (maybe && maybe.toLowerCase() === email.toLowerCase()) {
          log(`登录未确认，但页面已是 ${maybe} → 继续签到流程`);
          await handleCheckIn(email);
          return;
        }
        const n = retryOf(email) + 1;
        setRetry(email, n);
        log(`登录失败 (${n}/${MAX_RETRY_LOGIN})：${r.reason}`);
        if (n >= MAX_RETRY_LOGIN) {
          // 按需求：登录连续失败 3 次就"停止本轮"，既不退出也不推进索引
          log(`连续登录失败 ${MAX_RETRY_LOGIN} 次 → 停止本轮（不跳过账号，等你处理）`);
          notify(`登录 ${email} 连续失败 ${MAX_RETRY_LOGIN} 次，已停止，请检查密码或站点状态`);
          clearRetry(email);
          releaseSingletonLock();
        } else {
          await sleep(2500);
          location.reload();
        }
        return;
      }
    }

    await handleCheckIn(email);
  }

  /* ============================ 账号管理面板（UI） ============================
   * 需求：脚本内不再硬编码账号密码，改为在页面上录入；同时展示"今日已完成 x/y"。
   * 实现要点：
   * - 用 Shadow DOM：站点是 React + Tailwind，普通 div 会被全局样式/快捷键干扰，
   *   shadow root 里的样式既不外泄也不会被站点 CSS 改写。
   * - 面板只做"账号增删改 + 进度展示"，不参与自动签到流程；自动流程仍然只认
   *   accountsGet() / doneSet() / K_INDEX 这些状态。
   * - 密码只在展开时写进 DOM 文本（默认 ••••••••），避免截图/投屏泄露。
   * ======================================================================== */

  const PANEL_CSS = `
:host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;}
*{box-sizing:border-box;margin:0;padding:0;}
.fab{position:fixed;left:18px;bottom:18px;z-index:2;display:flex;align-items:center;gap:8px;height:38px;padding:0 13px;border:1px solid rgba(110,150,230,.5);border-radius:19px;background:rgba(18,22,30,.94);color:#e8eefb;font-size:13px;line-height:1;cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,.38);opacity:.9;transition:opacity .15s,transform .15s;}
.fab:hover{opacity:1;transform:translateY(-1px);}
.fab .ic{font-size:15px;line-height:1;}
.fab b{color:#7fb2ff;font-weight:700;font-variant-numeric:tabular-nums;}
.fab .cap{color:#95a1b5;font-size:11px;}
.mask{position:fixed;inset:0;z-index:1;display:none;align-items:center;justify-content:center;background:rgba(6,8,12,.62);}
.mask.open{display:flex;}
.win{display:flex;flex-direction:column;width:min(760px,calc(100vw - 28px));max-height:min(88vh,860px);border:1px solid #2a3240;border-radius:14px;background:#141922;color:#e6eaf2;box-shadow:0 24px 70px rgba(0,0,0,.55);overflow:hidden;}
.hd{display:flex;align-items:center;gap:8px;padding:13px 16px;border-bottom:1px solid #232b38;background:#171d27;}
.hd .t{font-size:15px;font-weight:700;}
.hd .sub{padding:2px 7px;border-radius:9px;background:#202836;color:#8b95a8;font-size:11px;}
.hd .x{margin-left:auto;width:28px;height:28px;padding:0;border-radius:8px;font-size:16px;line-height:1;}
.body{display:flex;flex-direction:column;gap:11px;padding:14px 16px;overflow:auto;scrollbar-width:thin;scrollbar-color:#36435a #141922;}
.body::-webkit-scrollbar,.list::-webkit-scrollbar,pre::-webkit-scrollbar{width:8px;height:8px;}
.body::-webkit-scrollbar-thumb,.list::-webkit-scrollbar-thumb,pre::-webkit-scrollbar-thumb{background:#36435a;border-radius:4px;}
.body::-webkit-scrollbar-track,.list::-webkit-scrollbar-track,pre::-webkit-scrollbar-track{background:transparent;}
.card{padding:12px;border:1px solid #262f3d;border-radius:10px;background:#181e28;}
.ttl{display:flex;align-items:center;gap:8px;margin-bottom:9px;color:#9aa5b8;font-size:12px;}
.ttl .grow{flex:1;}
.cnt{display:flex;align-items:baseline;gap:5px;color:#7fb2ff;font-size:27px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.1;}
.cnt .sp{color:#5c6678;font-size:14px;font-weight:400;}
.cnt .lbl{margin-left:5px;color:#9aa5b8;font-size:12px;font-weight:400;}
.bar{height:6px;margin:9px 0 7px;border-radius:3px;background:#0e1219;overflow:hidden;}
.bar i{display:block;width:0;height:100%;border-radius:3px;background:linear-gradient(90deg,#2f6bd8,#38d39f);transition:width .25s;}
.meta{color:#7d8798;font-size:11px;line-height:1.6;}
input,textarea{width:100%;padding:8px 10px;border:1px solid #2b3444;border-radius:7px;background:#0f141c;color:#e6eaf2;font-family:inherit;font-size:13px;outline:none;}
input:focus,textarea:focus{border-color:#4a7ddb;}
textarea{height:86px;resize:vertical;font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:12px;line-height:1.5;}
button{padding:7px 12px;border:1px solid #33405a;border-radius:7px;background:#222b39;color:#dde3ef;font-family:inherit;font-size:12px;white-space:nowrap;cursor:pointer;}
button:hover{background:#2a3446;}
button:disabled{opacity:.35;cursor:default;}
button.primary{border-color:#2f6bd8;background:#2f6bd8;color:#fff;}
button.primary:hover{background:#3a78e8;}
button.danger{border-color:#5a2f38;background:#3a2228;color:#ffb4c0;}
button.danger:hover{background:#4a2a32;}
button.mini{padding:3px 7px;font-size:11px;}
.row{display:flex;align-items:center;gap:8px;}
.row>input{flex:1;min-width:0;}
.hint{min-height:14px;margin-top:7px;color:#7d8798;font-size:11px;line-height:1.5;}
.hint.err{color:#ff9fae;}
.hint.ok{color:#5fd39b;}
.list{display:flex;flex-direction:column;gap:5px;}
.acc{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid #222a36;border-radius:7px;background:#10151d;font-size:12px;}
.acc.cur{border-color:#2f6bd8;background:#121a26;}
.acc .no{width:20px;flex:none;color:#6b7688;text-align:right;}
.acc .em{flex:1;min-width:0;overflow:hidden;color:#dbe3f0;white-space:nowrap;text-overflow:ellipsis;}
.acc .pw{width:118px;flex:none;overflow:hidden;color:#8b95a8;font-family:ui-monospace,Consolas,monospace;white-space:nowrap;text-overflow:ellipsis;}
.acc .st{flex:none;padding:2px 7px;border-radius:9px;background:#1d2a23;color:#5fd39b;font-size:10px;}
.acc .st.todo{background:#2a2417;color:#e2b45c;}
.acc .ops{display:flex;flex:none;gap:4px;}
.empty{padding:14px;color:#7d8798;font-size:12px;text-align:center;}
pre{max-height:104px;margin:0;overflow:auto;color:#8fa0b8;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-all;}
.ft{display:flex;gap:8px;padding:11px 16px;border-top:1px solid #232b38;background:#171d27;}
.ft .sp{flex:1;}
`;

  const PANEL_HTML = `
<button class="fab" data-act="open" title="A2E 每日签到：账号管理">
  <span class="ic">🎁</span><b data-ref="fabCount">0/0</b><span class="cap">A2E</span>
</button>
<div class="mask" data-ref="mask">
  <div class="win" role="dialog" aria-label="A2E 账号管理">
    <div class="hd">
      <span class="t">A2E 每日签到</span><span class="sub">账号管理</span>
      <button class="x" data-act="close" title="关闭（Esc）">×</button>
    </div>
    <div class="body">
      <div class="card">
        <div class="cnt"><span data-ref="done">0</span><span class="sp">/</span><span data-ref="total">0</span><span class="lbl">今日已完成</span></div>
        <div class="bar"><i data-ref="bar"></i></div>
        <div class="meta" data-ref="meta">—</div>
      </div>
      <div class="card">
        <div class="ttl"><span>添加账号</span></div>
        <div class="row">
          <input data-ref="email" type="text" placeholder="账号邮箱" autocomplete="off" spellcheck="false">
          <input data-ref="pass" type="password" placeholder="密码" autocomplete="new-password">
          <button class="primary" type="button" data-act="add">添加</button>
        </div>
        <div class="hint" data-ref="addMsg"></div>
      </div>
      <div class="card">
        <div class="ttl"><span>批量导入 / 导出</span></div>
        <textarea data-ref="bulk" placeholder="每行一个账号，支持：邮箱----密码 / 邮箱 密码 / 邮箱:密码 / 邮箱,密码（# 开头的行忽略）"></textarea>
        <div class="row" style="margin-top:8px">
          <input data-ref="defpass" type="password" placeholder="可选：默认密码（行内没写密码时使用）" autocomplete="new-password">
          <button type="button" data-act="import">批量导入</button>
          <button type="button" data-act="export" title="把当前账号列表写成 邮箱----密码，粘回上方即可备份">导出到上方</button>
        </div>
        <div class="hint" data-ref="impMsg"></div>
      </div>
      <div class="card">
        <div class="ttl"><span>账号列表</span><span class="grow" data-ref="listCnt"></span><button type="button" class="mini" data-act="showpass" data-ref="showpass">显示密码</button></div>
        <div class="list" data-ref="list"></div>
      </div>
      <div class="card">
        <div class="ttl"><span>最近日志</span></div>
        <pre data-ref="log">（暂无日志）</pre>
      </div>
    </div>
    <div class="ft">
      <button type="button" class="danger" data-act="reset">重置今日状态</button>
      <span class="sp"></span>
      <button type="button" class="primary" data-act="start" title="立即刷新页面，从"今日未完成"的第一个账号继续轮询">开始 / 继续轮询</button>
      <button type="button" data-act="close">关闭</button>
    </div>
  </div>
</div>
`;

  let panel = null;   // { host, root, refs, showPass, sig }

  function mountPanel() {
    if (panel) return panel;
    if (!document.body) return null;

    // 极端情况：脚本被注入两次 → 先清掉旧面板，避免两个悬浮按钮叠在一起
    const oldHost = document.getElementById('a2e-panel-host');
    if (oldHost && oldHost.parentNode) oldHost.parentNode.removeChild(oldHost);

    const host = document.createElement('div');
    host.id = 'a2e-panel-host';
    host.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:0;z-index:2147483647;';

    let root = null;
    try { root = host.attachShadow({ mode: 'open' }); } catch (e) { root = null; }
    if (!root) return null;

    // 优先用构造样式表（不受页面 CSP 的 style-src 影响），失败再退回 <style>
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(PANEL_CSS);
      root.adoptedStyleSheets = [sheet];
      root.innerHTML = PANEL_HTML;
    } catch (e) {
      root.innerHTML = '<style>' + PANEL_CSS + '</style>' + PANEL_HTML;
    }
    document.body.appendChild(host);

    const q = (s) => root.querySelector(s);
    const refs = {
      fab: q('.fab'),
      fabCount: q('[data-ref="fabCount"]'),
      mask: q('[data-ref="mask"]'),
      done: q('[data-ref="done"]'),
      total: q('[data-ref="total"]'),
      bar: q('[data-ref="bar"]'),
      meta: q('[data-ref="meta"]'),
      email: q('[data-ref="email"]'),
      pass: q('[data-ref="pass"]'),
      addMsg: q('[data-ref="addMsg"]'),
      bulk: q('[data-ref="bulk"]'),
      defpass: q('[data-ref="defpass"]'),
      impMsg: q('[data-ref="impMsg"]'),
      list: q('[data-ref="list"]'),
      listCnt: q('[data-ref="listCnt"]'),
      showpass: q('[data-ref="showpass"]'),
      log: q('[data-ref="log"]'),
    };

    panel = { host, root, refs, showPass: false, sig: '' };

    root.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t === refs.mask) { closePanel(); return; }
      const btn = t && t.closest ? t.closest('[data-act]') : null;
      if (!btn) return;
      ev.preventDefault();
      const act = btn.getAttribute('data-act');
      if (act === 'open') openPanel();
      else if (act === 'close') closePanel();
      else if (act === 'add') addFromForm();
      else if (act === 'import') importFromText();
      else if (act === 'export') exportToText();
      else if (act === 'showpass') toggleShowPass();
      else if (act === 'up') moveAccount(btn.getAttribute('data-email'), -1);
      else if (act === 'down') moveAccount(btn.getAttribute('data-email'), 1);
      else if (act === 'del') removeAccount(btn.getAttribute('data-email'));
      else if (act === 'reset') resetToday(true);
      else if (act === 'start') startRun();
    });

    root.addEventListener('keydown', (ev) => {
      // 站点自己的全局快捷键可能对输入框里的按键有反应 → 面板内不往页面冒泡
      ev.stopPropagation();
      if (ev.key === 'Escape') { closePanel(); return; }
      if (ev.key === 'Enter' && (ev.target === refs.email || ev.target === refs.pass)) {
        ev.preventDefault();
        addFromForm();
      }
    });

    refreshPanel(true);
    return panel;
  }

  function openPanel() {
    const p = mountPanel();
    if (!p) return;
    p.refs.mask.classList.add('open');
    refreshPanel(true);
    setTimeout(() => { try { p.refs.email.focus(); } catch (e) { /* ignore */ } }, 30);
  }

  function closePanel() {
    if (!panel) return;
    panel.refs.mask.classList.remove('open');
  }

  function setHint(refKey, text, kind) {
    if (!panel) return;
    const el = panel.refs[refKey];
    if (!el) return;
    el.textContent = text || '';
    el.className = 'hint' + (kind ? ' ' + kind : '');
  }

  /** 刷新顶部进度、角标、列表与日志。
   *  force=true 强制重建账号行；否则只在"账号/完成状态/索引"变化时重建，
   *  避免每 4s 一次的自刷新把用户正在点的按钮换掉。 */
  function refreshPanel(force) {
    const p = panel;
    if (!p) return;

    const list = accountsGet();
    const doneNow = doneEmailSet();
    const total = list.length;
    const done = list.filter((a) => doneNow.has(a.email.toLowerCase())).length;
    const idx = stateGet(K_INDEX, 0) | 0;
    const rd = runDate();
    const allDone = total > 0 && stateGet(K_DONE_DATE, '') === rd;
    const pendingCount = total - done;

    p.refs.done.textContent = String(done);
    p.refs.total.textContent = String(total);
    p.refs.bar.style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
    p.refs.fabCount.textContent = done + '/' + total;
    p.refs.fab.title = 'A2E 每日签到：今日已完成 ' + done + '/' + total + '（点击管理账号）';
    p.refs.meta.textContent = '任务日 ' + rd + '（平台每日 08:00 刷新）· 轮询进度 '
      + (total ? Math.min(idx + 1, total) : 0) + '/' + total
      + (!allDone && total ? ' · 当前：' + emailOf(list[Math.min(idx, total - 1)]) : '')
      + (allDone ? (pendingCount
        ? ' · 本轮已结束，' + pendingCount + ' 个未完成（可点「开始 / 继续轮询」重试）'
        : ' · 今日已全部完成') : '')
      + ' · 点「开始 / 继续轮询」立即执行';
    p.refs.listCnt.textContent = total + ' 个'
      + (allDone ? (pendingCount ? '（本轮结束，待重试 ' + pendingCount + '）' : '（今日已跑完）') : '');

    const sig = idx + '#' + list.map((a) => a.email.toLowerCase() + (doneNow.has(a.email.toLowerCase()) ? '*' : '')).join('|');
    if (force || sig !== p.sig) {
      p.sig = sig;
      renderAccounts(list, doneNow);
    }

    const logs = stateGet(K_LOG, []);
    p.refs.log.textContent = logs.slice(-14).join('\n') || '（暂无日志）';
  }

  function renderAccounts(list, doneNow) {
    const p = panel;
    if (!p) return;
    list = list || accountsGet();
    doneNow = doneNow || doneEmailSet();
    const idx = stateGet(K_INDEX, 0) | 0;

    const frag = document.createDocumentFragment();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '还没有账号。在上方输入邮箱和密码，或使用批量导入。';
      frag.appendChild(empty);
    }

    list.forEach((a, i) => {
      const done = doneNow.has(a.email.toLowerCase());

      const row = document.createElement('div');
      row.className = 'acc' + (i === idx ? ' cur' : '');

      const no = document.createElement('span');
      no.className = 'no';
      no.textContent = String(i + 1);

      const em = document.createElement('span');
      em.className = 'em';
      em.textContent = a.email;
      em.title = a.email;

      const pw = document.createElement('span');
      pw.className = 'pw';
      pw.textContent = a.password
        ? (p.showPass ? a.password : '••••••••')
        : '（未设置）';
      if (!p.showPass) pw.title = '点右上「显示密码」查看';

      const st = document.createElement('span');
      st.className = 'st' + (done ? '' : ' todo');
      st.textContent = done ? '已完成' : '待处理';

      const ops = document.createElement('span');
      ops.className = 'ops';
      const mk = (act, label, title, disabled) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mini';
        b.textContent = label;
        b.title = title;
        b.setAttribute('data-act', act);
        b.setAttribute('data-email', a.email);
        if (disabled) b.disabled = true;
        return b;
      };
      ops.appendChild(mk('up', '↑', '上移（越靠前越先处理）', i === 0));
      ops.appendChild(mk('down', '↓', '下移', i === list.length - 1));
      ops.appendChild(mk('del', '删除', '删除这个账号（不影响站点账号）', false));

      row.appendChild(no);
      row.appendChild(em);
      row.appendChild(pw);
      row.appendChild(st);
      row.appendChild(ops);
      frag.appendChild(row);
    });

    while (p.refs.list.firstChild) p.refs.list.removeChild(p.refs.list.firstChild);
    p.refs.list.appendChild(frag);
  }

  function addFromForm() {
    const p = panel;
    if (!p) return;
    const email = String(p.refs.email.value || '').trim();
    const password = String(p.refs.pass.value || '');
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
      setHint('addMsg', '邮箱格式不对，请检查：' + (email || '（空）'), 'err');
      p.refs.email.focus();
      return;
    }
    if (!password) {
      setHint('addMsg', '请填写密码', 'err');
      p.refs.pass.focus();
      return;
    }

    const list = accountsGet();
    const i = list.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
    if (i >= 0) list[i].password = password;
    else list.push({ email, password });
    accountsSet(list);
    repointIndexToPending();

    p.refs.email.value = '';
    p.refs.pass.value = '';
    setHint('addMsg', (i >= 0 ? '已更新密码：' : '已添加：') + email, 'ok');
    log((i >= 0 ? '更新账号密码：' : '添加账号：') + email);
    refreshPanel(true);
    p.refs.email.focus();
  }

  function importFromText() {
    const p = panel;
    if (!p) return;
    const parsed = parseAccountLines(p.refs.bulk.value, p.refs.defpass.value);
    if (!parsed.entries.length) {
      setHint('impMsg', '没有识别到有效账号'
        + (parsed.skipped.length ? '（' + parsed.skipped.length + ' 行缺密码或格式不对）' : ''), 'err');
      return;
    }

    const list = accountsGet();
    let added = 0;
    let updated = 0;
    for (const e of parsed.entries) {
      const i = list.findIndex((a) => a.email.toLowerCase() === e.email.toLowerCase());
      if (i >= 0) { list[i].password = e.password; updated++; }
      else { list.push(e); added++; }
    }
    accountsSet(list);
    repointIndexToPending();
    setHint('impMsg', '导入完成：新增 ' + added + ' 个，更新 ' + updated + ' 个'
      + (parsed.skipped.length ? '；忽略 ' + parsed.skipped.length + ' 行' : ''), 'ok');
    log('批量导入账号：新增 ' + added + '，更新 ' + updated);
    refreshPanel(true);
  }

  function exportToText() {
    const p = panel;
    if (!p) return;
    const text = accountsGet().map((a) => a.email + '----' + a.password).join('\n');
    p.refs.bulk.value = text;
    try { p.refs.bulk.focus(); p.refs.bulk.select(); } catch (e) { /* ignore */ }
    setHint('impMsg', text ? '已导出到上方文本框（可直接 Ctrl+C 备份）' : '账号列表为空', text ? 'ok' : 'err');
  }

  function toggleShowPass() {
    const p = panel;
    if (!p) return;
    p.showPass = !p.showPass;
    p.refs.showpass.textContent = p.showPass ? '隐藏密码' : '显示密码';
    refreshPanel(true);
  }

  function moveAccount(email, delta) {
    const list = accountsGet();
    const from = list.findIndex((a) => a.email.toLowerCase() === String(email || '').toLowerCase());
    const to = from + delta;
    if (from < 0 || to < 0 || to >= list.length) return;

    const tmp = list[from];
    list[from] = list[to];
    list[to] = tmp;
    accountsSet(list);

    // 索引跟着被移动的账号走，避免"移完顺序后跳过/重复处理"
    let idx = stateGet(K_INDEX, 0) | 0;
    if (idx === from) idx = to;
    else if (idx === to) idx = from;
    stateSet(K_INDEX, idx);
    stateSet(K_NEXT, '');
    log('调整账号顺序：' + email + (delta < 0 ? ' 上移' : ' 下移'));
    refreshPanel(true);
  }

  function removeAccount(email) {
    const list = accountsGet();
    const pos = list.findIndex((a) => a.email.toLowerCase() === String(email || '').toLowerCase());
    if (pos < 0) return;
    if (!window.confirm('删除账号 ' + email + '？\n只删除本地记录，不影响站点上的账号。')) return;
    list.splice(pos, 1);
    accountsSet(list);
    repointIndexToPending();
    log('删除账号：' + email);
    refreshPanel(true);
  }

  /** 账号列表变化后，把索引指向"第一个今日未完成的账号"。
   *  这样：新增账号能立刻被处理、删掉已完成账号不会让索引越过列表末尾、
   *  当天已标"全部完成"但后来又加了账号时，会自动撤销完成标记（否则 main 直接 return）。 */
  function repointIndexToPending() {
    const list = accountsGet();
    const doneNow = doneEmailSet();
    let i = list.findIndex((a) => !doneNow.has(a.email.toLowerCase()));
    if (i < 0) i = list.length;
    stateSet(K_INDEX, i);
    stateSet(K_NEXT, i < list.length ? emailOf(list[i]) : '');
    if (i < list.length && stateGet(K_DONE_DATE, '') === runDate()) stateSet(K_DONE_DATE, '');
  }

  /** 开始 / 继续轮询：从第一个未完成账号起跑（已完成的不会重跑）。
   *  为什么要重置索引：跳过/失败重试用尽会把索引推过某些没做成的账号，
   *  这时直接刷新会直接 finishAll，用户以为"跑了但没领到"。 */
  function startRun() {
    const list = accountsGet();
    if (!list.length) { openPanel(); setHint('addMsg', '请先添加账号', 'err'); return; }
    const doneNow = doneEmailSet();
    const i = list.findIndex((a) => !doneNow.has(a.email.toLowerCase()));
    if (i < 0) {
      notify('今日已完成 ' + list.length + '/' + list.length + '，没有待处理账号；如需重跑请点「重置今日状态」');
      return;
    }
    stateSet(K_INDEX, i);
    stateSet(K_NEXT, emailOf(list[i]));
    stateSet(K_DONE_DATE, '');
    const doneCount = list.length - list.filter((a) => !doneNow.has(a.email.toLowerCase())).length;
    log(`手动开始 / 继续轮询：从第 ${i + 1} 个账号 ${emailOf(list[i])} 起（今日已完成 ${doneCount}/${list.length}）`);
    closePanel();
    // 留 1.2s：GM_setValue 是异步写盘，账号刚导入就 reload 可能把这次写入丢掉
    setTimeout(() => location.reload(), 1200);
  }

  function resetToday(ask) {
    if (ask && !window.confirm('重置今日状态与轮询索引？\n（不会删除账号列表）')) return;
    stateSet(K_DONE_DATE, '');
    stateSet(K_RUN_DATE, null);   // 清掉本轮固定的任务日，下次加载按"现在"重新定
    stateSet(K_INDEX, 0);
    stateSet(K_NEXT, '');
    stateSet(K_GUARD, { t: 0, n: 0 });
    stateSet(K_CHECKIN, null);
    stateSet(K_PEND, null);
    stateSet(K_DONE_SET, null);
    stateSet(K_LOUT, null);
    for (const a of accountsGet()) {
      stateSet(K_RETRY + a.email, 0);
      stateSet(K_RETRY_POINTS + a.email, 0);
    }
    releaseSingletonLock(); // 顺手放掉可能残留的单例锁
    notify('已重置今日状态、索引与重试计数，正在刷新页面');
    setTimeout(() => location.reload(), 800);
  }

  /** 解析批量导入文本：每行 `邮箱----密码` / `邮箱 密码` / `邮箱:密码` / `邮箱,密码` / tab 分隔。
   *  - 行首 # 或 // 视为注释；
   *  - 行内没写密码 → 用 defaultPassword；
   *  - 邮箱非法或最终没密码 → 进 skipped（不静默丢弃，面板会报数量）。 */
  function parseAccountLines(text, defaultPassword) {
    const entries = [];
    const skipped = [];
    const idxByEmail = new Map();
    const seps = ['----', '——', '\t', '|', ',', '，', ':'];

    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || /^(#|\/\/)/.test(line)) continue;

      let email = '';
      let password = '';
      for (const s of seps) {
        const at = line.indexOf(s);
        if (at > 0) {
          email = line.slice(0, at).trim();
          password = line.slice(at + s.length).trim();
          break;
        }
      }
      if (!email) {
        const parts = line.split(/\s+/);
        email = parts.shift() || '';
        password = parts.join(' ').trim();
      }
      if (!password) password = String(defaultPassword || '');
      if (!/^[^\s@]+@[^\s@]+$/.test(email) || !password) { skipped.push(line); continue; }

      // 同一批里重复的邮箱：后写的密码覆盖先写的（更像"改密"而不是丢弃）
      const key = email.toLowerCase();
      if (idxByEmail.has(key)) {
        entries[idxByEmail.get(key)].password = password;
        continue;
      }
      idxByEmail.set(key, entries.length);
      entries.push({ email, password });
    }
    return { entries, skipped };
  }

  /* ============================ 菜单与启动 ============================ */

  GM_registerMenuCommand('打开账号管理面板', () => openPanel());
  GM_registerMenuCommand('查看今日签到进度', () => {
    const list = accountsGet();
    const msg = '今日已完成 ' + todayDoneCount() + '/' + list.length
      + '（任务日 ' + runDate() + '，平台每日 08:00 刷新）';
    log(msg);
    notify(msg);
    openPanel();
  });
  GM_registerMenuCommand('手动重置今日状态', () => resetToday(false));

  // 面板先挂上：即使 main() 因为"今日已完成 / 没有账号"提前 return，用户也能录入账号
  try { mountPanel(); } catch (e) { console.warn('[A2E] 面板初始化失败：', e); }

  // 角标与"今日已完成"每 4s 自刷新（列表行只在状态真的变化时重建）
  setInterval(() => {
    try { refreshPanel(false); } catch (e) { /* ignore */ }
  }, 4000);

  main().catch((e) => {
    log('主流程异常：' + (e && e.message ? e.message : String(e)));
    releaseSingletonLock();
  });
})();

