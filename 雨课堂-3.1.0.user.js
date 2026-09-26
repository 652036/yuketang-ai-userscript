// ==UserScript==
// @name         雨课堂刷课助手
// @namespace    http://tampermonkey.net/
// @version      3.1.0
// @description  雨课堂课程自动播放与 AI 辅助答题
// @author       652036
// @license      GPL3
// @match        *://*.yuketang.cn/*
// @match        *://*.gdufemooc.cn/*
// @match        *://examination.xuetangx.com/*
// @run-at       document-start
// @icon         http://yuketang.cn/favicon.ico
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.openai.com
// @connect      *
// ==/UserScript==
// 雨课堂刷课脚本（基于风之子原版改版，感谢上游作者的开源贡献）
/*
  已适配雨课堂学校及网址：
  学校：中原工学院，河南大学研究院，辽宁大学，河北大学，中南大学，电子科技大学，华北电力大学，上海理工大学研究生院及其他院校...
  网址：changjiang.yuketang.cn，yuketang.cn ...
*/


const _attachShadow = Element.prototype.attachShadow;
const basicConf = {
  version: '3.1.0',
  rate: 3, //用户可改 视频播放速率,可选值[1,1.25,1.5,2,3,16],默认为2倍速，实测4倍速往上有可能出现 bug，3倍速暂时未出现bug，推荐二倍/一倍。
  pptTime: 3000, // 用户可改 ppt播放时间，单位毫秒
}

const $ = { // 开发脚本的工具对象
  runtime: {
    paused: false,
    running: false
  },
  progress: {
    total: 0,
    completed: 0,
    skipped: 0,
    current: 0,
    currentTitle: ''
  },
  updateProgress(opts) {
    if (opts.total !== undefined) this.progress.total = opts.total;
    if (opts.completed !== undefined) this.progress.completed = opts.completed;
    if (opts.skipped !== undefined) this.progress.skipped = opts.skipped;
    if (opts.current !== undefined) this.progress.current = opts.current;
    if (opts.currentTitle !== undefined) this.progress.currentTitle = opts.currentTitle;
    // 通知面板更新
    if (this._onProgressUpdate) this._onProgressUpdate(this.progress);
  },
  _onProgressUpdate: null,
  panel: "",      // panel节点，后期赋值
  observer: "",   // 保存observer观察对象
  userInfo: {     // 实时同步刷课记录，避免每次都从头开始检测
    allInfo: {},              // 刷课记录，运行时赋值
    getProgress(classUrl) {   // 参数：classUrl:课程地址
      if (!localStorage.getItem("[雨课堂脚本]刷课进度信息"))   // 第一次初始化这个localStorage
        this.setProgress(classUrl, 0, 0);
      this.allInfo = JSON.parse(localStorage.getItem("[雨课堂脚本]刷课进度信息"));  // 将信息保存到本地
      if (!this.allInfo[classUrl])         // 第一次初始化这个课程
        this.setProgress(classUrl, 0, 0);
      console.log(this.allInfo);
      return this.allInfo[classUrl];   // 返回课程记录对象{outside:外边第几集，inside:里面第几集}
    },
    setProgress(classUrl, outside, inside = 0) {   // 参数:classUrl:课程地址,outside为最外层集数，inside为最内层集数
      this.allInfo[classUrl] = {
        outside,
        inside
      }
      localStorage.setItem("[雨课堂脚本]刷课进度信息", JSON.stringify(this.allInfo));   // localstorage只能保存字符串，需要先格式化为字符串
    },
    removeProgress(classUrl) {   // 移除课程刷课信息，用在课程刷完的情况
      delete this.allInfo[classUrl];
      localStorage.setItem("[雨课堂脚本]刷课进度信息", JSON.stringify(this.allInfo));
    }
  },
  alertMessage(message) { // 向页面中添加信息
    const target = $.panel && $.panel.querySelector ? $.panel.querySelector('.n_infoAlert') : null;
    if (!target) {
      console.log('[雨课堂脚本]', message);
      return;
    }
    const li = document.createElement("li");
    li.innerText = message;
    target.appendChild(li);
  },
  setRunning(running) {
    this.runtime.running = running;
    if (!running) {
      this.runtime.paused = false;
    }
  },
  isPaused() {
    return this.runtime.paused === true;
  },
  getMediaDocuments(rootDocument = document) {
    const docs = [rootDocument];
    rootDocument.querySelectorAll('iframe').forEach((iframe) => {
      try {
        if (iframe.contentDocument) {
          docs.push(iframe.contentDocument);
        }
      } catch (error) {
        // Ignore cross-origin frames.
      }
    });
    return docs;
  },
  pauseAllMedia() {
    $.getMediaDocuments().forEach((doc) => {
      doc.querySelectorAll('video, audio').forEach((media) => {
        try {
          if (!media.paused) {
            media.pause();
          }
        } catch (error) {
          console.log('pause media failed', error);
        }
      });
    });
    $.observer?.disconnect();
  },
  async waitWhilePaused() {
    while ($.isPaused()) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  },
  ykt_speed() {   // 视频加速
    const rate = basicConf.rate || 2;
    let speedwrap = document.getElementsByTagName("xt-speedbutton")[0];
    let speedlist = document.getElementsByTagName("xt-speedlist")[0];
    let speedlistBtn = speedlist.firstElementChild.firstElementChild;

    speedlistBtn.setAttribute('data-speed', rate);
    speedlistBtn.setAttribute('keyt', rate + '.00');
    speedlistBtn.innerText = rate + '.00X';
    $.alertMessage('已开启' + rate + '倍速');

    // 模拟点击
    let mousemove = document.createEvent("MouseEvent");
    mousemove.initMouseEvent("mousemove", true, true, unsafeWindow, 0, 10, 10, 10, 10, 0, 0, 0, 0, 0, null);
    speedwrap.dispatchEvent(mousemove);
    speedlistBtn.click();
  },
  claim() {   // 视频静音
    document.querySelector("#video-box > div > xt-wrap > xt-controls > xt-inner > xt-volumebutton > xt-icon").click();
    $.alertMessage('已开启静音');
  },
  videoDetail(video = document.querySelector('video')) {  // 不用鼠标模拟操作就能实现的一般视频加速静音方法
    if (!video || $.isPaused()) return;
    video.volume = 0;
    video.playbackRate = basicConf.rate;
    video.play();
    $.alertMessage(`实际上已默认静音和${basicConf.rate}倍速`);
  },
  audioDetail(audio = document.querySelector('audio')) {   // 音频处理
    if (!audio || $.isPaused()) return;
    audio.volume = 0;
    audio.playbackRate = basicConf.rate;
    audio.play();
    $.alertMessage(`实际上已默认静音和${basicConf.rate}倍速`);
  },
  preventScreenCheck() {  // 阻止pro/lms雨课堂切屏检测  PRO-2684贡献
    const unsafeWin = unsafeWindow;
    const blackList = new Set(["visibilitychange", "blur", "pagehide"]); // 限制调用事件名单：1.选项卡的内容变得可见或被隐藏时2.元素失去焦点3.页面隐藏事件
    const isDebug = false;
    const log = console.log.bind(console, "[阻止pro/lms切屏检测]");
    const debug = isDebug ? log : () => { };
    unsafeWin._addEventListener = unsafeWin.addEventListener;
    unsafeWin.addEventListener = (...args) => {                  // args为剩余参数数组
      if (!blackList.has(args[0])) {                          // args[0]为想要定义的事件，如果不在限制名单，调用原生函数
        debug("allow unsafeWin.addEventListener", ...args);
        return document._addEventListener(...args);
      } else {                                                // 否则不执行，打印参数信息
        log("block unsafeWin.addEventListener", ...args);
        return undefined;
      }
    };
    document._addEventListener = document.addEventListener;
    document.addEventListener = (...args) => {
      if (!blackList.has(args[0])) {
        debug("allow document.addEventListener", ...args);
        return unsafeWin._addEventListener(...args);
      } else {
        log("block document.addEventListener", ...args);
        return undefined;
      }
    };
    log("addEventListener hooked!");
    if (isDebug) { // DEBUG ONLY: find out all timers
      unsafeWin._setInterval = unsafeWin.setInterval;
      unsafeWin.setInterval = (...args) => {
        const id = unsafeWin._setInterval(...args);
        debug("calling unsafeWin.setInterval", id, ...args);
        return id;
      };
      debug("setInterval hooked!");
      unsafeWin._setTimeout = unsafeWin.setTimeout;
      unsafeWin.setTimeout = (...args) => {
        const id = unsafeWin._setTimeout(...args);
        debug("calling unsafeWin.setTimeout", id, ...args);
        return id;
      };
      debug("setTimeout hooked!");
    }
    Object.defineProperties(document, {
      hidden: {                 // 表示页面是（true）否（false）隐藏。
        value: false
      },
      visibilityState: {        // 当前可见元素的上下文环境。由此可以知道当前文档 (即为页面) 是在背后，或是不可见的隐藏的标签页
        value: "visible"        // 此时页面内容至少是部分可见
      },
      hasFocus: {               // 表明当前文档或者当前文档内的节点是否获得了焦点
        value: () => true
      },
      onvisibilitychange: {     // 当其选项卡的内容变得可见或被隐藏时，会在 document 上触发 visibilitychange 事件  ==  visibilitychange
        get: () => undefined,
        set: () => { }
      },
      onblur: {                 // 当元素失去焦点的时候
        get: () => undefined,
        set: () => { }
      }
    });
    log("document properties set!");
    Object.defineProperties(unsafeWin, {
      onblur: {
        get: () => undefined,
        set: () => { }
      },
      onpagehide: {
        get: () => undefined,
        set: () => { }
      },
    });
    log("unsafeWin properties set!");
  }
}
if (typeof window.$ === 'function') {
  Object.assign(window.$, $);
} else {
  window.$ = $;
}
window.__yktHelper = $;
window.start = start;
window.basicConf = basicConf;
if (typeof unsafeWindow !== 'undefined' && unsafeWindow) {
  if (typeof unsafeWindow.$ === 'function') {
    Object.assign(unsafeWindow.$, $, { start, basicConf });
  } else {
    unsafeWindow.$ = window.$;
  }
  unsafeWindow.__yktHelper = $;
  unsafeWindow.start = start;
  unsafeWindow.basicConf = basicConf;
}

function getPageHostWindow() {
  try {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow.document) {
      return unsafeWindow;
    }
  } catch (e) {}
  try {
    if (window.parent && window.parent.document) {
      return window.parent;
    }
  } catch (e) {}
  return window;
}

function addWindow() {
  // 创建iframe
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.top = window.innerHeight < 500 ? '8px' : '40px';
  iframe.style.left = window.innerWidth < 540 ? '8px' : '40px';
  iframe.style.width = Math.min(500, Math.max(160, window.innerWidth - 16)) + 'px';
  iframe.style.height = Math.min(460, Math.max(240, window.innerHeight - 16)) + 'px';
  iframe.style.zIndex = '999999';
  iframe.style.border = '1px solid #a3a3a3';
  iframe.style.borderRadius = '10px';
  iframe.style.background = '#fff';
  iframe.style.boxShadow = '6px 4px 17px 2px #000000';
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('id', 'ykt-helper-iframe');
  iframe.setAttribute('allowtransparency', 'true');
  document.body.appendChild(iframe);

  // iframe内容
  const doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open();
  doc.write(`
    <style>
      body { margin:0; font-family: Avenir, Helvetica, Arial, sans-serif; color: #636363; background:transparent; }
      .mini-basic{
        position: absolute;
        top: 0;
        left: 0;
        background: linear-gradient(135deg, #007bff, #00d2ff);
        border: none;
        height: 50px;
        width: 50px;
        border-radius: 50%;
        text-align: center;
        line-height: 50px;
        z-index: 1000000;
        cursor: pointer;
        display: none;
        color: white;
        font-size: 12px;
        box-shadow: 0 4px 15px rgba(0, 123, 255, 0.4);
        transition: all 0.3s ease;
        user-select: none;
      }
      .mini-basic:hover {
        transform: scale(1.1);
        box-shadow: 0 6px 20px rgba(0, 123, 255, 0.6);
      }
      .mini-basic.show { display:block; }
      .n_panel { width:100%; height:100%; background:#fff; border-radius:10px; position:relative; display:flex; flex-direction:column; overflow:hidden; }
      .n_header {
        text-align:center;
        height:40px;
        background:#f7f7f7;
        color:#000;
        font-size:18px;
        line-height:40px;
        border-radius:10px 10px 0 0;
        border-bottom:2px solid #eee;
        cursor:move;
        position:relative;
        transition: background-color 0.2s ease;
      }
      .n_header:hover {
        background:#f0f0f0;
      }
      .tools{position:absolute;right:0;top:0;}
      .tools ul{margin:0;padding:0;}
      .tools ul li{position:relative;display:inline-block;padding:0 5px;cursor:pointer;}
      .tools ul li:focus-visible{outline:2px solid #1769aa;outline-offset:2px;}
      .tools ul li.minimality::after{
        content:'最小化';
        display:none;
        position:absolute;
        left:0;
        bottom:-30px;
        height:32px;
        width:50px;
        font-size:12px;
        background:#ffffe1;
        color:#000;
        border-radius:3px;
      }
      .tools ul li.minimality:hover::after{display:block;}
      .tools ul li.question::after{
        content:'有问题';
        display:none;
        position:absolute;
        left:0;
        bottom:-30px;
        height:32px;
        width:50px;
        font-size:12px;
        background:#ffffe1;
        color:#000;
        border-radius:3px;
      }
      .tools ul li.question:hover::after{display:block;}
      .tools ul li.close::after{
        content:'关闭助手';
        display:none;
        position:absolute;
        left:0;
        bottom:-30px;
        height:32px;
        width:50px;
        font-size:12px;
        background:#ffebee;
        color:#c62828;
        border-radius:3px;
      }
      .tools ul li.close:hover::after{display:block;}

      .speed-tab {
        display:none;
        position:absolute;
        top: 54px;
        right: 12px;
        background:white;
        border:1px solid #ddd;
        border-radius:8px;
        box-shadow:0 4px 12px rgba(0,0,0,0.15);
        padding:15px;
        z-index:1000001;
        min-width: 200px;
        max-width: calc(100% - 24px);
        box-sizing: border-box;
      }
      .speed-tab.show { display:block; }
      .speed-tab h4 {
        margin: 0 0 10px 0;
        color: #333;
        font-size: 14px;
      }
      .speed-options {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
        margin-bottom: 10px;
      }
      .speed-option {
        padding: 8px 12px;
        border: 1px solid #ddd;
        border-radius: 4px;
        text-align: center;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s ease;
      }
      .speed-option:hover {
        background: #f5f5f5;
        border-color: #007bff;
      }
      .speed-option.active {
        background: #007bff;
        color: white;
        border-color: #007bff;
      }
      .custom-speed {
        margin-top: 10px;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .custom-speed input {
        width: 60px;
        padding: 4px 8px;
        border: 1px solid #ddd;
        border-radius: 4px;
        text-align: center;
      }
      .custom-speed button {
        padding: 4px 12px;
        background: #28a745;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
      }
      .custom-speed button:hover {
        background: #218838;
      }
      .n_body { font-weight:bold; font-size:13px; line-height:26px; flex:1; min-height:0; overflow-y:auto; padding-bottom:8px; }
      .n_infoAlert { margin:0; padding:0; list-style:none; }
      .n_progress_bar { padding:6px 10px; background:#f0f4ff; border-top:1px solid #e0e6f0; display:none; }
      .n_progress_bar.show { display:block; }
      .n_progress_info { display:flex; justify-content:space-between; align-items:center; font-size:12px; color:#555; margin-bottom:4px; }
      .n_progress_info .label { font-weight:bold; color:#333; }
      .n_progress_info .stats { color:#007bff; }
      .n_progress_track { width:100%; height:8px; background:#e0e6f0; border-radius:4px; overflow:hidden; position:relative; }
      .n_progress_fill { height:100%; background:linear-gradient(90deg, #007bff, #00d2ff); border-radius:4px; transition:width 0.5s ease; width:0%; }
      .n_progress_current { font-size:11px; color:#888; margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .n_footer { background:#f7f7f7; color:#555; font-size:13px; line-height:25px; border-radius:0 0 10px 10px; border-top:2px solid #eee; display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 10px; box-sizing:border-box; max-height:60%; overflow-y:auto; }
      .n_footer p { margin:0; flex:1 1 100%; }
      #n_button, #n_clear, #n_speed, #n_pause, #n_autoAnswer { border-radius:6px; border:0; background-color:#1769aa; color:#fff; cursor:pointer; padding:6px 10px; min-width:96px; flex:1 1 120px; text-align:center; }
      #n_button:hover, #n_pause:hover { background-color:yellow; color:#000; }
      #n_autoAnswer { background-color:#4caf50; }
      #n_autoAnswer:hover { background-color:#388e3c; }
      #n_autoAnswer.active { background-color:#c62828; }
      .n_footer button:focus-visible, .n_footer input:focus-visible, .ai-settings summary:focus-visible { outline:2px solid #1769aa; outline-offset:2px; }
      .n_footer button:disabled { opacity:.65; cursor:wait; }
      .auto-submit-toggle { display:flex; align-items:center; gap:6px; flex:1 1 100%; padding:4px 0; font-size:12px; color:#555; }
      .auto-submit-toggle label { cursor:pointer; display:flex; align-items:center; gap:4px; }
      .auto-submit-toggle input[type=checkbox] { cursor:pointer; }
      .ai-settings { flex:1 1 100%; border:1px solid #cbd7e3; border-radius:6px; padding:4px 8px; background:#fff; }
      .ai-settings summary { cursor:pointer; font-weight:600; color:#1769aa; }
      .ai-settings label { display:block; margin-top:6px; font-size:12px; line-height:18px; }
      .ai-settings input { width:100%; min-width:0; box-sizing:border-box; padding:5px 7px; border:1px solid #b7c7d8; border-radius:4px; font-size:12px; }
      .ai-settings input[type=checkbox] { width:auto; margin-right:4px; }
      .ai-settings .ai-key-row { display:flex; gap:6px; }
      .ai-settings .ai-key-row button, #n_saveAiSettings { border:0; border-radius:4px; background:#1769aa; color:#fff; padding:5px 9px; cursor:pointer; white-space:nowrap; }
      .ai-settings .ai-key-row button { flex:none; }
      .ai-settings .ai-hint, #n_aiStatus { display:block; font-size:11px; line-height:17px; color:#555; }
      #n_aiStatus { margin:4px 0; }
    </style>
    <div class="mini-basic" id="mini-basic">放大</div>
    <div class="n_panel" id="n_panel">
      <div class="n_header" id="n_header">
        雨课堂刷课助手
        <div class='tools'>
          <ul>
            <li class='minimality' id="minimality" role="button" tabindex="0" aria-label="最小化">_</li>
            <li class='close' id="close" role="button" tabindex="0" aria-label="关闭助手">×</li>
            <li class='question' id="question" role="button" tabindex="0" aria-label="帮助">?</li>
          </ul>
        </div>
      </div>
      <div class="n_body">
        <ul class="n_infoAlert" id="n_infoAlert" aria-live="polite">
          <li>⭐ 脚本支持：雨课堂所有版本，支持多倍速，自动播放</li>
          <li>📢 使用方法：点击进入要刷的课程目录，点击开始刷课按钮即可自动运行</li>
          <li>⚠️ 运行后请不要随意点击刷课窗口，可新开窗口，可最小化浏览器</li>
          <li>💡 拖动上方标题栏可以进行拖拽哦!</li>
          <li>⭐ 招募有时间和精力的大学生参与到本项目里，一起把项目做的更好。</li>
          <hr>
        </ul>
      </div>
      <div class="n_progress_bar" id="n_progress_bar">
        <div class="n_progress_info">
          <span class="label" id="n_progress_label">📊 总进度</span>
          <span class="stats" id="n_progress_stats">0 / 0</span>
        </div>
        <div class="n_progress_track">
          <div class="n_progress_fill" id="n_progress_fill"></div>
        </div>
        <div class="n_progress_current" id="n_progress_current"></div>
      </div>
      <div class="n_footer">
        <p>雨课堂助手 ${basicConf.version}</p>
        <button id="n_clear">清除进度缓存</button>
        <button id="n_speed">倍速设置</button>
        <button id="n_pause">暂停刷课</button>
        <button id="n_autoAnswer">AI 答题</button>
        <div class="auto-submit-toggle">
          <label><input type="checkbox" id="n_autoSubmit"> 答题完成后自动提交</label>
        </div>
        <details class="ai-settings" id="n_aiSettings">
          <summary>AI 接口设置</summary>
          <label for="n_aiEndpoint">Chat Completions 接口地址</label>
          <input id="n_aiEndpoint" type="url" autocomplete="url" placeholder="https://api.openai.com/v1/chat/completions">
          <label for="n_aiModel">模型名称</label>
          <input id="n_aiModel" type="text" autocomplete="off" placeholder="填写服务商提供的模型 ID">
          <label for="n_aiKey">API 密钥</label>
          <div class="ai-key-row">
            <input id="n_aiKey" type="password" autocomplete="off" placeholder="留空则保留当前密钥">
            <button id="n_toggleAiKey" type="button" aria-label="显示密钥">显示</button>
            <button id="n_clearAiKey" type="button">清除密钥</button>
          </div>
          <label><input id="n_rememberAiKey" type="checkbox"> 在油猴中记住密钥</label>
          <label><input id="n_allowHttp" type="checkbox"> 允许远程 HTTP 接口（题目和密钥会明文传输）</label>
          <span class="ai-hint">题目会发送到所填接口。直连密钥会在浏览器中使用，建议使用受限密钥。</span>
          <button id="n_saveAiSettings" type="button">保存接口</button>
        </details>
        <span id="n_aiStatus" role="status" aria-live="polite">尚未配置接口</span>
        <button id="n_button">开始刷课</button>
      </div>
    </div>

    <!-- 倍速设置选项卡 -->
    <div class="speed-tab" id="speedTab">
      <h4>🎯 倍速设置</h4>
      <div class="speed-options">
        <div class="speed-option" data-speed="1">1.0X</div>
        <div class="speed-option" data-speed="1.25">1.25X</div>
        <div class="speed-option" data-speed="1.5">1.5X</div>
        <div class="speed-option" data-speed="2">2.0X</div>
        <div class="speed-option" data-speed="2.5">2.5X</div>
        <div class="speed-option" data-speed="3">3.0X</div>
        <div class="speed-option" data-speed="4">4.0X</div>
        <div class="speed-option" data-speed="6">6.0X</div>
        <div class="speed-option" data-speed="8">8.0X</div>
      </div>
      <div class="custom-speed">
        <span>自定义:</span>
        <input type="number" id="customSpeedInput" min="0.5" max="10" step="0.1" placeholder="输入倍数">
        <button id="setCustomSpeed">设置</button>
      </div>
    </div>
  `);
  doc.close();

  // 返回iframe内部需要用到的元素
  return {
    iframe,
    doc,
    panel: doc.getElementById('n_panel'),
    header: doc.getElementById('n_header'),
    button: doc.getElementById('n_button'),
    pause: doc.getElementById('n_pause'),
    clear: doc.getElementById('n_clear'),
    infoAlert: doc.getElementById('n_infoAlert'),
    minimality: doc.getElementById('minimality'),
    question: doc.getElementById('question'),
    close: doc.getElementById('close'),
    miniBasic: doc.getElementById('mini-basic'),
    speedTab: doc.getElementById('speedTab'),
    customSpeedInput: doc.getElementById('customSpeedInput'),
    setCustomSpeed: doc.getElementById('setCustomSpeed'),
    speedOptions: doc.querySelectorAll('.speed-option'),
    n_speed: doc.getElementById('n_speed'),
    autoAnswer: doc.getElementById('n_autoAnswer'),
    autoSubmit: doc.getElementById('n_autoSubmit'),
    aiSettings: doc.getElementById('n_aiSettings'),
    aiEndpoint: doc.getElementById('n_aiEndpoint'),
    aiModel: doc.getElementById('n_aiModel'),
    aiKey: doc.getElementById('n_aiKey'),
    rememberAiKey: doc.getElementById('n_rememberAiKey'),
    allowHttp: doc.getElementById('n_allowHttp'),
    toggleAiKey: doc.getElementById('n_toggleAiKey'),
    clearAiKey: doc.getElementById('n_clearAiKey'),
    saveAiSettings: doc.getElementById('n_saveAiSettings'),
    aiStatus: doc.getElementById('n_aiStatus'),
    progressBar: doc.getElementById('n_progress_bar'),
    progressStats: doc.getElementById('n_progress_stats'),
    progressFill: doc.getElementById('n_progress_fill'),
    progressCurrent: doc.getElementById('n_progress_current'),
    progressLabel: doc.getElementById('n_progress_label')
  };
}

function addUserOperate() {
  const { iframe, doc, panel, header, button, pause, clear, infoAlert, minimality, question, close, miniBasic, speedTab, customSpeedInput, setCustomSpeed, speedOptions, n_speed, autoAnswer, autoSubmit, aiSettings, aiEndpoint, aiModel, aiKey, rememberAiKey, allowHttp, toggleAiKey, clearAiKey, saveAiSettings, aiStatus, progressBar, progressStats, progressFill, progressCurrent, progressLabel } = addWindow();
  const normalIframeWidth = parseInt(iframe.style.width, 10);
  const normalIframeHeight = parseInt(iframe.style.height, 10);
  const expandedIframeHeight = Math.min(560, Math.max(240, window.parent.innerHeight - 16));
  $.panel = panel;
  $.alertMessage = function (message) {
    const li = doc.createElement('li');
    li.innerText = message;
    infoAlert.appendChild(li);
  };
  for (const control of [minimality, close, question]) {
    control.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        control.click();
      }
    });
  }

  // 高性能拖拽功能
  let isDragging = false, offsetX = 0, offsetY = 0;
  let lastMoveTime = 0;
  let dragRAF = null;

  // 缓存常用值
  const iframeWidth = parseInt(iframe.style.width) || normalIframeWidth;
  const iframeHeight = parseInt(iframe.style.height) || normalIframeHeight;
  const maxWidth = window.parent.innerWidth;
  const maxHeight = window.parent.innerHeight;

  let startScreenX, startScreenY, startLeft, startTop;

  header.addEventListener('mousedown', function (e) {
    isDragging = true;
    startScreenX = e.screenX;
    startScreenY = e.screenY;
    startLeft = parseInt(iframe.style.left) || 40;
    startTop = parseInt(iframe.style.top) || 40;
    iframe.style.transition = 'none';
    doc.body.style.userSelect = 'none';
    header.style.cursor = 'grabbing';
    e.preventDefault(); // 防止文本选择
  });

  doc.addEventListener('mousemove', function (e) {
    if (!isDragging) return;

    if (dragRAF) cancelAnimationFrame(dragRAF);

    dragRAF = requestAnimationFrame(() => {
      let newLeft = startLeft + (e.screenX - startScreenX);
      let newTop = startTop + (e.screenY - startScreenY);

      // 动态获取当前iframe尺寸（可能在最小化状态下）
      const currentWidth = parseInt(iframe.style.width) || 500;
      const currentHeight = parseInt(iframe.style.height) || 250;

      // 实时获取窗口大小
      const currentMaxWidth = window.parent.innerWidth;
      const currentMaxHeight = window.parent.innerHeight;

      // 边界检查
      newLeft = Math.max(0, Math.min(currentMaxWidth - currentWidth, newLeft));
      newTop = Math.max(0, Math.min(currentMaxHeight - currentHeight, newTop));

      iframe.style.left = newLeft + 'px';
      iframe.style.top = newTop + 'px';
    });
  });

  function stopDragging() {
    if (isDragging) {
      isDragging = false;
      iframe.style.transition = '';
      doc.body.style.userSelect = '';
      header.style.cursor = 'move';
      miniBasic.style.cursor = 'pointer'; // 恢复miniBasic的cursor

      if (dragRAF) {
        cancelAnimationFrame(dragRAF);
        dragRAF = null;
      }
    }
  }

  doc.addEventListener('mouseup', stopDragging);
  doc.addEventListener('mouseleave', stopDragging);

  // 添加鼠标离开iframe时的处理
  iframe.addEventListener('mouseout', function (e) {
    // 检查是否真的离开了iframe区域
    if (!iframe.contains(e.relatedTarget)) {
      stopDragging();
    }
  });

  // 最小化
  minimality.addEventListener('click', function () {
    panel.style.display = 'none';
    miniBasic.classList.add('show');
    // 调整iframe尺寸为mini-basic的尺寸
    iframe.style.width = '50px';
    iframe.style.height = '50px';
    // 隐藏iframe背景和边框
    iframe.style.border = 'none';
    iframe.style.background = 'transparent';
    iframe.style.boxShadow = 'none';
  });
  // 放大
  miniBasic.addEventListener('click', function () {
    panel.style.display = '';
    miniBasic.classList.remove('show');
    // 恢复iframe原始尺寸
    iframe.style.width = normalIframeWidth + 'px';
    iframe.style.height = normalIframeHeight + 'px';
    // 恢复iframe背景和边框
    iframe.style.border = '1px solid #a3a3a3';
    iframe.style.background = '#fff';
    iframe.style.boxShadow = '6px 4px 17px 2px #000000';
  });

  // 为mini-basic添加拖拽功能
  miniBasic.addEventListener('mousedown', function (e) {
    isDragging = true;
    startScreenX = e.screenX;
    startScreenY = e.screenY;
    startLeft = parseInt(iframe.style.left) || 40;
    startTop = parseInt(iframe.style.top) || 40;
    iframe.style.transition = 'none';
    doc.body.style.userSelect = 'none';
    miniBasic.style.cursor = 'grabbing';
    e.preventDefault();
  });

  // 有问题按钮
  question.addEventListener('click', function () {
    $.alertMessage('作者网站：niuwh.cn；作者博客：blog.niuwh.cn');
  });

  // 倍速设置功能
  let isSpeedTabOpen = false;

  // 倍速按钮点击事件 - 页脚按钮
  n_speed.addEventListener('click', function (e) {
    e.stopPropagation();
    isSpeedTabOpen = !isSpeedTabOpen;
    if (isSpeedTabOpen) {
      speedTab.classList.add('show');
      iframe.style.height = expandedIframeHeight + 'px';
      updateSpeedDisplay();
    } else {
      speedTab.classList.remove('show');
      iframe.style.height = normalIframeHeight + 'px';
    }
  });

  // 点击其他地方关闭倍速选项卡
  doc.addEventListener('click', function (e) {
    if (isSpeedTabOpen && !speedTab.contains(e.target) && !n_speed.contains(e.target)) {
      speedTab.classList.remove('show');
      isSpeedTabOpen = false;
      iframe.style.height = normalIframeHeight + 'px';
    }
  });

  // 倍速选项点击事件
  speedOptions.forEach(option => {
    option.addEventListener('click', function () {
      const speedValue = parseFloat(this.getAttribute('data-speed'));
      setSpeed(speedValue);
      // 更新活跃状态
      speedOptions.forEach(opt => opt.classList.remove('active'));
      this.classList.add('active');
    });
  });

  // 自定义倍速设置
  setCustomSpeed.addEventListener('click', function () {
    const customSpeed = parseFloat(customSpeedInput.value);
    if (customSpeed && customSpeed >= 0.5 && customSpeed <= 10) {
      setSpeed(customSpeed);
      // 更新所有选项的活跃状态
      speedOptions.forEach(opt => opt.classList.remove('active'));
      customSpeedInput.value = '';
    } else {
      $.alertMessage('请输入有效的倍速值（0.5-10倍）');
    }
  });

  // 回车键设置自定义倍速
  customSpeedInput.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
      setCustomSpeed.click();
    }
  });

  // 设置倍速函数
  function setSpeed(speedValue) {
    // 更新全局配置
    if (window.parent.basicConf) {
      window.parent.basicConf.rate = speedValue;
      // 同步到 localStorage
      localStorage.setItem('[雨课堂脚本]倍速设置', speedValue.toString());
    }
    updateSpeedDisplay();
    $.alertMessage(`✅ 倍速已设置为 ${speedValue}x`);
    console.log('倍速已设置为:', speedValue);
  }

  // 更新倍速显示
  function updateSpeedDisplay() {
    const currentSpeed = window.parent.basicConf ? window.parent.basicConf.rate : 2;
    // 更新所有选项的活跃状态
    speedOptions.forEach(option => {
      const optionSpeed = parseFloat(option.getAttribute('data-speed'));
      if (Math.abs(optionSpeed - currentSpeed) < 0.01) {
        option.classList.add('active');
      } else {
        option.classList.remove('active');
      }
    });
  }

  // 初始化倍速设置
  function initSpeedSettings() {
    // 从 localStorage 读取保存的倍速设置
    const savedSpeed = localStorage.getItem('[雨课堂脚本]倍速设置');
    if (savedSpeed) {
      const speedValue = parseFloat(savedSpeed);
      if (speedValue && window.parent.basicConf) {
        window.parent.basicConf.rate = speedValue;
      }
    }
    updateSpeedDisplay();
  }

  // 页面加载时初始化倍速设置
  initSpeedSettings();

  // 关闭按钮 - 关闭后自动暂停
  close.addEventListener('click', function () {
    try {
      // 1. 暂停所有视频和音频
      const videos = window.parent.document.querySelectorAll('video');
      const audios = window.parent.document.querySelectorAll('audio');

      videos.forEach(video => {
        if (!video.paused) {
          video.pause();
          console.log('已暂停视频:', video.src || video.currentSrc);
        }
      });

      audios.forEach(audio => {
        if (!audio.paused) {
          audio.pause();
          console.log('已暂停音频:', audio.src || audio.currentSrc);
        }
      });

      // 2. 断开MutationObserver监听
      if (window.parent.$.observer) {
        window.parent.$.observer.disconnect();
        console.log('已断开MutationObserver监听');
      }

      // 3. 清理定时器
      window.parent.$.setRunning(false);
      window.parent.$.runtime.paused = false;
      syncRunButtons();
      const currentButtons = panel.querySelectorAll('button');
      currentButtons.forEach(btn => {
        if (btn.id === 'n_button') {
          btn.innerText = '开始刷课';
        }
      });

      // 4. 显示关闭消息
      $.alertMessage('🛑 助手已关闭，视频已暂停');

      // 5. 延迟移除iframe，确保用户能看到关闭消息
      // 5. 延迟移除iframe，确保用户能看到关闭消息
      setTimeout(() => {
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
          console.log('助手窗口已关闭');
        }
      }, 500);

    } catch (error) {
      console.error('关闭助手时出错:', error);
      // 即使出错也要移除窗口
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
    }
  });

  // 刷课按钮
  function syncRunButtons() {
    pause.innerText = window.parent.$.isPaused() ? '继续刷课' : '暂停刷课';
  }

  syncRunButtons();

  button.onclick = function () {
    window.parent.$.runtime.paused = false;
    const started = window.parent.start && window.parent.start();
    const pathname = window.parent.location?.pathname || '';
    const hasCourseList = !!window.parent.document.querySelector('.logs-list .content-box section');
    const canKeepRunning = started !== false && (!pathname.includes('/v2/web/') || (hasCourseList && !pathname.includes('/student-lesson-report/')));
    window.parent.$.setRunning(canKeepRunning);
    button.innerText = canKeepRunning ? '刷课中~' : '开始刷课';
    syncRunButtons();
  };

  pause.onclick = function () {
    const runtime = window.parent.$;
    const hasActiveMedia = !!window.parent.document.querySelector('video, audio') || !!window.parent.document.querySelector('iframe');
    if (!runtime.runtime.running && !hasActiveMedia) {
      runtime.alertMessage('当前没有正在运行的任务');
      syncRunButtons();
      return;
    }

    runtime.runtime.paused = !runtime.runtime.paused;
    if (runtime.isPaused()) {
      runtime.pauseAllMedia();
      button.innerText = '已暂停';
      runtime.alertMessage('已暂停刷课');
    } else {
      const docs = runtime.getMediaDocuments(window.parent.document);
      let resumedMedia = false;
      docs.forEach((doc) => {
        const video = doc.querySelector('video');
        const audio = doc.querySelector('audio');
        if (video) {
          video.volume = 0;
          video.playbackRate = window.parent.basicConf.rate;
          video.play();
          resumedMedia = true;
        }
        if (audio) {
          audio.volume = 0;
          audio.playbackRate = window.parent.basicConf.rate;
          audio.play();
          resumedMedia = true;
        }
      });
      if (!resumedMedia && runtime.runtime.running) {
        window.parent.start && window.parent.start();
      }
      button.innerText = runtime.runtime.running ? '刷课中~' : '开始刷课';
      runtime.alertMessage('已继续刷课');
    }
    syncRunButtons();
  };
  // 清除数据按钮
  clear.onclick = function () {
    window.parent.$.userInfo.removeProgress(window.parent.location.href);
    window.parent.localStorage.removeItem('pro_lms_classCount');
  };

  const externalLoaderState = {
    opentype: null
  };
  const encryptedGlyphState = {
    fontMaps: new Map(),
    fontLoads: new Map()
  };
  const EXAM_FONT_GLYPH_HASH_MAP = {"dd13c0750c220c66":"科","9083bffc9f5d56c2":"序","dadbf21e9c3a5439":"命","bdb93fdbb025de2f":"少","dcf87fe9dc0aa639":"而","bdb6c7a64d168f90":"持","af158af6cb1bc527":"胆","16022b8b07c29a44":"站","ef5ff861e164a229":"子","7eac991e17989210":"菌","e72b59e372ade63b":"功","63614fbff2cc8803":"辑","7e8e594bcc60e29b":"杆","1a798de2d4e680a4":"直","6d43183d652afc46":"除","df6a5dd315196607":"磁","c0cea88c53d0dc50":"指","84dd37dbd97bd897":"济","9b7e427228906a56":"仿","7415c3404b7600e8":"板","4cf1053639b83824":"隔","fa1472f47203339c":"律","9d69cd1f46edf00c":"没","a1b5d691e14ab0da":"府","a9ea93d56b2dff2f":"究","980ac25d30c38325":"题","7386b4104a9fe7b9":"随","d7883feb89478054":"联","9e6431b1b7bf85af":"满","71fed7d9f174cd5e":"液","9dbf656c95809276":"么","0a21ba94d0091349":"军","6e7c440ef1fbee99":"古","1f9fc3d42d18df8e":"由","b2b0b1a789c00b1d":"裂","76042147d194e743":"滑","c3012411c7881bf4":"够","047bfd5e325f72fd":"兴","05613c3a695a3ba4":"思","76ec8cf3d6a7fee6":"费","cfc154449fed39ad":"历","ef7fcc2c4bd3a26c":"障","29a29885f18ad175":"钟","fd96dc5ff031d7c4":"词","e1e1e626da2f5eba":"癌","45e793e97ed78d41":"右","660999b014a6904f":"他","70adab35bf0e63e1":"多","7c45c99a6f08bdcc":"令","d681ef9525591c30":"特","21b7a25d79d8aa20":"小","e7fa43283af214c7":"国","f8d0b5b8b9438703":"广","9d4c290c3223f32c":"材","02939753a2784ed2":"档","f9ace4137d12597c":"宫","59c41d6ff5150181":"做","369d0aca3b79876a":"黑","895899722acae130":"灯","6b26698f3f22867a":"抽","c7bdad83842a7e90":"室","628644de0c85e93d":"克","94a95699fcaf5434":"党","94e4d890c1063bb8":"乙","0db30807891d6704":"仪","7e267461c4051978":"院","a6cb9b5b3db77b98":"乳","20751ed634bfc9ff":"英","fb9ccfe9bd33e0a7":"足","0df99c15e3cc23df":"疾","87995fffaffdb85b":"德","6a8a02627548c8e7":"物","fb55f7c3d6643b94":"可","39c96c49473c80e5":"两","454367f4cc57b046":"其","410f8f8035dd2aa6":"包","0116fd8fd480bf9a":"书","b5981f567319423d":"腹","d70afec9bee3d0a7":"者","79961b6c44e7805a":"射","14c3462d301e09bd":"参","5e1dd2849432349a":"论","d6d675bf11ce810c":"新","184baa33b0500ea2":"质","8b4201c65285229e":"户","4be30fc3e6cb5582":"手","97571e6a14e280cd":"剂","51f541a92e16aaa2":"间","5c68fa269c090dd3":"石","e20ab6280843fa0e":"本","0b180eac2b6cf34d":"饮","976e75a590a5c3a2":"善","30f332f834f52dee":"余","e723b192562fb663":"区","116fe3eee0649557":"数","d34637727a67f7f5":"三","99fb9e55dea54504":"且","e803426f8122a7e7":"确","45bdeb7d057b27b9":"旋","d4f32be34a6be083":"范","9ab7c94e552a8fd5":"志","691d52eb37d144b1":"想","79d351218d0235dc":"肢","618d6c08f7deef0c":"激","d47019e688323e8a":"燃","5e0cf0796fc849c6":"业","b007ed2fd6697b88":"频","9374784051672c63":"研","119e740501b918db":"四","3f51bf8064c7541b":"难","d17ef206594403d9":"胞","17e0bc64ca14ee3c":"排","c2d83e804e40beea":"货","24f4c0013f1440b1":"践","8b2a5d03c29c4186":"毒","be4db6df72543ac0":"技","9aef7741a721ffb9":"基","ba024baa5121daee":"同","c98585748cabab1b":"定","de5a5c74eafcd78d":"则","da260fb275fca3f7":"染","3e72a568320dccef":"营","4df7afa5c14c7acd":"强","126e1c3ccd47ce0b":"据","40763b2acc4dd8c2":"尺","6d46fa9dcb90dfc4":"告","5abacd53a885e84c":"胃","8c946769a70c9040":"汽","d3dafdb122441038":"益","2c5516ca1f1527e4":"连","d4f48acdba5c5d90":"全","8e4a3fe4d7d8d3bb":"念","a308b9d10c5ccfb6":"某","58c8662fb737828b":"支","f55383ad7c3802aa":"镜","8b4261b77d482202":"政","0bd31a2e22ed77d9":"应","10d74e5b56107049":"限","2e572d45f8eaac0a":"模","5486f4d9641f68fd":"大","169121c392f9f389":"币","a0766b33decc1d29":"央","f2a5b2c1b64023c2":"闭","f2b3a6c0a3614407":"宋","136fc3704b8bf463":"学","4c6028c2244203b0":"农","eac36462eb565f50":"章","9b8606cf94ff480e":"旅","d5fb249c298ab862":"虫","9c5e2eddf2607692":"油","ed19d83be8c31ffe":"答","c1c3bbafe65561a9":"缺","5202f6f027c30d90":"率","fe63fdb95a8f03fd":"航","9da140e1b38c84aa":"零","7fabbf2b0128e11e":"担","809f69e92b5b4730":"源","ffff82c52f5007b1":"机","5eb9e97bf73c8dc3":"走","7938949a0e5f37ad":"称","b9623c51459ca6e7":"代","494f123cda304667":"酒","862a200ca647a80c":"短","9109ff199b8bd4db":"台","e0dea408529115ac":"互","8bba355857ead061":"绝","0a1cfc45c6ffa441":"折","7d78d2447303deda":"住","adf228c8e87e5da0":"复","ebd9e1556b193c8d":"冲","76d149ed00cd528d":"快","6e5fd42d2faa31cd":"平","7502730f5f8a12e4":"至","199e2d897603912b":"人","37f6720e92021030":"肾","163defa66c9c68e2":"向","1ee4c8960a3c0f5b":"供","dba833785ba51e18":"元","990428a51a50c0e1":"并","f7b9080412652860":"创","7e580fc236a68c42":"语","ddf9f5514b9a8f88":"精","92d2b8fe0742a41b":"底","2d96708cb3b65301":"求","33db81a3ece0ae5a":"监","30e3fdcab121beee":"食","09e03ea04a5de9f1":"起","a6e23fa0b9857998":"各","b08e23e153382f5f":"请","119e4d9dff56815e":"月","a00e92a5104b418a":"予","d908c0a5391cf28a":"件","cfdff2ef668030bb":"目","1ab499e29f90a3a1":"放","0c71770f8de5d9d1":"记","7eb9702a27f6740d":"里","3958183a6206891a":"观","61ae15b39575129b":"证","4def0b74ce4c4e8f":"胸","50e64d5198ff378d":"现","6ea6c5caa327b961":"后","5a6517acd5cdb193":"冷","d1b79091e57a98d6":"页","345dff8fe3f137dc":"年","5b008976005e9013":"灭","def7638ae5b5b248":"送","4647e1fb86851e24":"认","c7b8542e9bfce61b":"比","24aa40077b478b12":"纳","cb1259a6c514fc95":"配","303461451811eff6":"失","30c629b654e4d644":"势","73e6a4b814f078f3":"术","7174d44defdf6798":"因","04c2f8e47cffd0a7":"极","1baa3de83ec07ed9":"胎","20a5dcd74d731708":"动","0c0009492c694cea":"那","c9bf8ac59e5a77f8":"针","7f69ce7bedf1f11d":"销","b296155aa6bddb2f":"增","898800b0fcc2ce59":"网","b380ed88e3eb37a5":"维","35d765552afc27f9":"对","be80ac5fcc0b1b0a":"依","098916b8ef1bd953":"期","6cf0a5b812553181":"控","213a78c09c9e4b62":"织","f1ea6ee73228cdc6":"温","47d6cbf2bf5ddbdd":"紧","535bfaadb411a1c7":"疗","6541d484840952cd":"力","db3e14f6587a05ac":"价","d88d46feef7f0f47":"打","00fd39880e1ed60a":"己","ca4507e6e1878e9c":"急","ff20e936b9bc419d":"问","222ef88f6786bf81":"争","241858189ac2dc1b":"已","b17d4e58bdf77675":"此","d4d2abb199d6bc69":"银","dc39a0750f556c77":"识","616ae9e1ccab017e":"般","1aa4d810aa6d7e61":"相","3e4a67a97bb2e448":"青","759dad1b0f72dce8":"碱","1f7b1e1732d917cc":"左","58eed81dbcd43043":"习","268e26576349b7be":"推","efc989cb44cf5dc8":"湿","6937e6bad40c913f":"签","1052f38e52b20507":"设","ca0dbb16933a343e":"转","803c71dd49c3dde4":"否","362dcc2e0488a748":"女","8bfef42613887f89":"们","dd5e265a9d1feb57":"爱","dffa4173607f1cb5":"破","db186691d40fcf60":"列","678f0e2af25bfd1c":"脱","a6870044af0c1e94":"句","d23fe47fab179044":"脑","d6440a01dff48218":"避","7b0712fc291509c6":"编","f9834e61d9bb2faa":"膜","55adc6ab975c643e":"空","86c53390d0a493c1":"脉","9df8c6df599c663f":"先","0ea2a622674148e8":"核","3e84ac88f0c0aef1":"诊","a5d9a46a657f35c7":"整","07ea7b056663b84f":"例","e9729ef466ce0c7e":"括","c29acbd0a88222c5":"让","54b6f498f58a63aa":"文","2207b199cf65f20a":"离","c530e2da7b4a9f2d":"若","6b41713603aadf97":"料","49ca818ccf5bd229":"中","a423f2c5590a2062":"内","3cb67bded522a1db":"火","09e153742eed62a7":"什","eff2e35d433482e0":"干","b8732dd6c1b572a9":"与","08b8af0f19e74f4d":"该","e891378040846131":"过","ef33635430b759b0":"像","f598606c188716b5":"害","29ec428f7711484c":"叙","5156684b57940814":"症","259d673c83d3cd5f":"门","d30fa61646edfbb0":"通","7eb9ea49708aa239":"金","fe63c54a5a3a6702":"皮","a3ca5994ac80521c":"何","034be7f654dd4e48":"服","65708ecad002a8ee":"作","58d0d9022b7c9def":"回","904957b9e372fede":"更","348c51abfa7201bc":"展","8dd77a9f6015ee7c":"络","9eec896994179f8d":"分","32894ecc35f1f405":"号","a3f4c63b1271c97e":"封","75c5951eb3f68483":"规","4b33deb3000fd8f7":"顺","dbecc37970419bbc":"流","d4437dfb602b9e39":"声","d7569ebdca9a39ae":"险","8539135e1d6322d9":"水","5a6c4fad07457332":"载","e3c3f3d135fb53df":"布","e028edd689ac1d15":"你","e4368e573326e574":"铁","b29528f4d9dca6a5":"结","22bfdf7836b4fd41":"好","99d25923dae42a25":"类","019322d3da626fdf":"升","1b4cdd00c6a788aa":"静","506a945804e7d07f":"码","9f0016f4e20facec":"态","2718acc7d52e6384":"山","539b79ee188947f6":"硬","a9f2786a04a9b217":"装","de6bf35412aec7bc":"纪","3bf6cafe02e03fc9":"士","c48c0cc7a2636844":"酶","6cb606caede48cb6":"误","c81aed4d6000803a":"前","ecfa0e4147cfc4c9":"径","2436ecb15e82c456":"素","2ef536fc93dda93b":"图","160702b83b362d4a":"工","0252be709fcc1dde":"炎","c53c5c07ed910027":"票","5dd2ff97defaf330":"白","52f9586291e2d705":"矛","4293aa4c585dbe10":"效","44c0bb9fed0717a0":"西","6c191f973a7ab4b2":"印","e89093b3db294473":"块","c74a335f89971fc9":"法","311a5a3f8c94fd6a":"约","15b9e1e8da536c8b":"算","d0cdd79044099bb7":"果","a397f8abc84da3d2":"托","f4c70157e7bba2b5":"付","f70d4ed8f1794921":"凝","9255b1e0cf4deeac":"卫","7a2abf57ccc73305":"必","dde4d08841977311":"适","bdf1554ec2000910":"海","9ccceba4808ffa9a":"违","114009d836f3f739":"群","1e4745fbbf825d24":"个","d1417fafe36736c7":"任","4e35716967d7b700":"映","cd3ff78a486e1b49":"众","75d030b8f40fc157":"腺","50fdb9619a87d592":"肺","e52f42deb7f58726":"头","515ede94af2f9064":"致","816b696af91e581a":"改","faf905c6dd3ec53d":"就","1de170c79e9b14cd":"些","0d5c39d7191c8c6f":"报","3509ee0a8b312076":"采","6d05d33c90d90ecb":"受","972a91640c2705de":"美","a88d5de36e40809e":"导","c52d55c7ed4b112c":"养","06e82190c436819b":"域","2eca93ba81c95f5c":"示","a5ca7650b2432ad4":"播","461fb9b86c72243c":"瘤","86cf1d504ec9431c":"音","5eaeded0080a991e":"财","94db45964cea7051":"坚","87a5f08dcd3d8b49":"优","6c409f992e55cdbb":"楷","6def32f1f325e4e9":"血","6cbdd008e635fb82":"象","cd042be09a54773b":"健","de8078e2c3c89279":"宜","ed0dee45758c2e12":"教","4bf88a58d25775f3":"天","1c73e65604b2b14c":"半","82f7ac70d3cf9d83":"医","ba183d77450a54dc":"提","fdc610f5f68b461d":"斗","5354115eaa7e606e":"略","fe49ea7cd7510f1c":"差","5b20e24f23c2f6f7":"防","12ddfac62487d454":"产","eae7598269ed00da":"叶","b4fb9db8f5824968":"非","19c8a069947693b6":"华","87d0ec017d60cce3":"标","fce0d742aba70ef5":"被","1d01b2b78bc3e0fa":"债","c9b53b58ed0fc387":"要","d26beecfe34060ad":"考","74e46cb06db92336":"投","fe3cb3076c64190e":"圆","be7e6fedc092d440":"痛","5d753d3eff856b5d":"来","575175532f89045e":"促","edc2890bb2d1f40c":"盘","cccfc113fd9b83c2":"近","251f7224b4f1db84":"触","92355d667ec16ad3":"严","410c6f26069870b8":"再","f1f81b2e67eb2164":"故","765933353449f37e":"散","1f0718e2af3685a1":"电","99e23d53a4dbe7be":"生","a85b9cdee87abd4a":"决","c0118ca9663dd380":"普","66e44b2781f18495":"东","7a3a65bf4b050bf9":"清","3efb03fa526fe723":"波","01e6c893b1887970":"五","b0219c3d1638dfd5":"市","ee742c37551211b0":"格","911138da10d53b81":"说","3c93ba730f44e5ff":"性","31cdc9cfa08aa544":"岁","82ac25faf2e64d63":"合","1c05f4f1bede6515":"危","96c71b9800cf9ac8":"填","10829d84c1179f33":"扩","291c689906359710":"偏","58f9aff4f4979ac0":"置","98b240b12026b5c4":"继","07b7fb8d05e878f5":"北","753abbb60cd1a1d1":"位","6513ef7e3b7d51db":"骨","e4d2f0b0747acf50":"概","3f01dfff3338064a":"节","426e00628a236518":"围","60b4f75d6d219b3a":"式","2063b91ce751fa7e":"速","71fd4783ecefd39c":"轮","201138fab4e8461b":"换","9e84158dae6ccbe2":"塞","0a2476058dbaf298":"础","c05063c57d5bb333":"断","222766845444b5ae":"征","62f9047113d4e043":"存","28116e1270503b90":"库","3c6e63f9c6956939":"交","b014357940c9a855":"反","2b7b4b4d45952894":"很","824d6ba5335c6d2b":"脏","ea22841d11daa010":"收","f136e3ceca3d942f":"润","a9b17f5db2a5fd5e":"出","b4e8b1267ca46133":"但","de848b654eb44c37":"预","07019ca67f3856f0":"路","77dd596613129bc4":"警","edb9a12ed10e88dd":"只","e1f922da70ee9d49":"往","15f792c1e0a1bc9e":"或","51a07fdfb83e6082":"才","33b7e183768f02be":"补","72b4f426854a00fc":"见","5e321e8e7919e1ef":"劳","7e979b0289e2e678":"得","0cff21b862efa2ff":"别","f839ed04e6634825":"单","5314070d271e67f5":"孔","9994401ca7efb6e9":"低","2ef08e649ad4936a":"的","5c2d42dc405bdae2":"照","2fa76ac6d17cbc4d":"常","dd489759f98ae3af":"越","0e8725e956312e24":"双","7c2f38441346a559":"脂","9d91220afe7c34c3":"含","430df53ac09fca3e":"录","1eaf26925de3f7fd":"毛","42d9d6666b30fdb9":"这","973954f44890e4b7":"措","178fc576b637ca80":"房","2d0d30e28b33cdd7":"于","0399ee52ccde97ac":"资","89ed81ebe478988b":"器","cd1c22b3e91f1afb":"买","bef6a264ec0e371f":"客","7660d17ae4eebccd":"条","d7dd17bad0e09b4f":"神","0fe16cbe78882e3f":"容","cef97aa71e64fee0":"息","a4f0bff5feb4e358":"键","b60838dae6a05105":"安","526b1583db8b1ba1":"边","0407a1734f407f66":"培","e55b87e21784fa44":"幼","e414c8e6b2e8ef0a":"份","92a2234018019963":"景","53cc4e32157a4360":"片","ec0ea83a8a990b2b":"化","3a77b8620e2c301a":"气","88bcf5335bfbb0ac":"易","4742619402a303fd":"尿","4f62148bc19324c6":"审","2f4339fb201fc087":"解","432d95b4291a1f07":"理","518efd91b7fc2a73":"肝","8efb6c6fd02b0c6e":"准","c210ff62d873571a":"面","f80b185134fd3eb7":"远","3bf93802321d3d4c":"救","053998036e349943":"环","dc5c52e93fad33a1":"商","8f96f91d7b6c6036":"及","ea965b176c459245":"终","5514b58bbf95a4ec":"写","486d7559069a6f90":"组","650132d9cee34d3d":"吸","c5499511692445ec":"程","06da0f11fe5abadc":"透","ad8ec40c61e7a044":"储","dd552b6c1780bf66":"正","6c587cd2e293eb7a":"入","fbf3dd75fc730851":"种","515168866b43fa5b":"高","dc358bf026eb5d83":"稳","453cafe9be0ca0ea":"外","d45c9461404d6ea3":"族","cad93ef3b31af824":"线","20f00f05d9357e77":"甲","a4ebc1c043ac19e2":"测","89b654dbb641f3c0":"康","0521af57bbece56f":"延","efb3f3a26dc4e4e4":"账","7dd79463da7b67ed":"知","2cb7770ca48d0538":"富","74348530effdab44":"充","525368c3153eec54":"额","0f6011323eb56476":"真","d753708875288391":"立","54ed4ea981eb0f59":"口","31da81d015913ac7":"游","4b55fdc942b6a7c7":"二","0e072b196a60bab3":"风","185de725033e5995":"描","113c59f4c7bb427f":"到","7286d1c9e885dd5b":"取","ee5f3f7dc3b95c41":"款","636bb5ef645da056":"企","c8f681e5563c8347":"链","7a8a3f38e2c85135":"统","af9f5f3b585e78cd":"花","0fb32ceef2d0a6cc":"须","aef78fa04a13ae55":"第","b118c6a07ad0be99":"城","671b9e2b3a9155c2":"传","4b5e364b6fffa8bb":"检","2784b17398eae083":"软","ef03ea368e89704e":"和","211845a7bfcf951e":"微","c7f7640714edc88e":"重","3eca0e03be951b07":"字","6062f1c26b1e653d":"议","1c0f535475bd44a5":"抗","9978a0546351b3db":"意","ed2895f51d0d8fea":"能","b98f54d081b54cfc":"退","022d6c3b2de8aca8":"责","ae0dcd8cd53cf61f":"敏","e25df442e949d6eb":"批","9b19c043586707d4":"介","3ea8ab2380432808":"密","a2a2203bc7427e90":"日","e27f3d6e4ef4eaaa":"母","5ada8d0891b6fe8f":"需","80a7c8873109858e":"造","db27fce44b0a0334":"输","d882b1317c195cf7":"名","f86ea66cd38cc7a7":"为","442dc5d1550ff67f":"查","2b4aa5c84fd79282":"护","7be77959fee6ad39":"试","3e669e8fdb4db760":"利","f3acbb88560e621c":"择","247aeb26af362e9b":"处","ada20f2d4705ac52":"身","2c159db1b45b1d50":"坏","32f068b4e3f9748c":"画","dc9f106303bbb416":"响","2d5d572cd289d911":"属","397901456786d9fe":"读","48f260d52c78c619":"即","d2c23f609fc5bcf5":"浓","79d3fa7a5a5e948c":"场","92b936f48ee74ae1":"减","83670ecd924188a1":"积","fc95a0910c20a905":"蛋","86a213d7ebf33e04":"循","4ec2dc43c8af3d34":"构","1e0c54f04676d8e2":"看","d881be724b1ff979":"义","87179c3317ecd8ca":"专","c89299ebd049ced7":"况","187f88cfb09343ca":"际","69d593c5f140d3cc":"牙","8002aa51866e44d8":"拉","922786ed4943a420":"心","035307ff613276f9":"初","116b77e8dd3bc4e6":"权","f660ed4060d256fa":"验","2fb923867900a7f4":"协","12120a3c6ec11698":"信","f995cca18814db08":"儿","cb2b5ec89c0255b3":"轴","8a6c971a5986e17a":"境","200594c3d47c7b3d":"无","e3f43f5b9c2bd951":"在","7c05bc02566e707d":"述","febb00c824b8d56e":"侧","c3e970547dd1e0e5":"根","c908dc0367b41825":"然","ed7dd3ae2216783e":"次","bdea1e4ca05a276d":"形","04012c0bad0438b6":"溶","d922a4e6d9bf998c":"床","87469b19006621fc":"一","ad7f4a4f6b132e67":"早","4e06fe21e14f97ee":"巴","a90410c33503f77c":"男","bac845bcab3318b7":"委","5590f9d8663c438e":"了","fa76ab656784f736":"下","31209a2b66c9ab1d":"制","02f95dae708fe75e":"眼","e389287bd0fb96d0":"未","e408f330cad4bc53":"进","4646fd227f54b28f":"以","f93a6a68cd948602":"将","4e97ca1562197ace":"部","ea2ee9486b444199":"训","5e7224ee93c631e9":"轻","3766d7842bdd5ef2":"品","3a17c74a4e279295":"员","afdf3f3c7514603f":"酸","4a4b861a7755be44":"接","b6c595ba78950a79":"停","9a935578410ec8a3":"固","12c7d8b2c3c4b743":"关","eb533313ea847132":"点","8b78c19c35455762":"职","1ce8538c5bc7537f":"腔","2499f9f36794e71e":"获","d9feb19aa8710de5":"切","cbc9d2a02f683702":"临","ddc0641ef4411d3c":"言","7a8c90da730efb4f":"体","66802f31ef1550eb":"杂","bdefb29eec516902":"系","9f3e9380042ebc13":"世","869ddb9c09f7d00b":"伤","ac43b045fc6f3672":"税","c194d1ca4ebe7268":"判","edbab708efd206c7":"道","4473aca38e07ac78":"发","215f06121d5aafd3":"虑","ec0fe2662bf5ff1e":"加","c516b4a7ab9fa556":"阻","6539372961c23cf2":"红","d807e982e73f5007":"估","dd09c65252c7ac28":"领","4208ce9aaaccfdd0":"也","2f7e347b3cc20b04":"最","bef5192a063b8612":"亚","a9f473bdfa432066":"家","575067628b862615":"异","ad08d0df2b520614":"当","d28ebecac4870828":"许","55078cf8981595f5":"死","a35789c841d8f3a9":"革","1d68635d9f1d3124":"史","b248d360c61c6465":"粒","47dfcf831eb30142":"缩","43aad3c9cabf09a0":"共","7131ff8d6b17929f":"首","20972697d488935c":"班","76e3ec936c38acf6":"光","369be667be342a79":"地","053ecdf32c6e8bba":"等","29cd9638f991b5d3":"曲","b28defeddc70951b":"队","821c9981ebc0ac54":"集","d85c491694a7b9e0":"明","b45d7c89fcc0f4d0":"步","c09c701f016dcc9d":"状","8fd92af7a89b5d01":"课","4546f351ba433c64":"斯","0097a6bdba644494":"束","bef2a45604261568":"完","3ea5b0acd187a46e":"划","5ceb14150af86d88":"计","4713bb57d6db1986":"便","21c955d39bd01c9f":"所","b0fe648ea6301cae":"方","4c0715b996be39ef":"育","826f310f65fcae93":"段","966585a6f98900d3":"司","42bec31ae6c2cae4":"保","b34d53d998a62631":"万","606aa0903fdc983c":"层","4aed37f1856feaeb":"错","362343a4f8b579da":"情","4acaa336bb83ccbd":"公","3b6e324a5e38f7cb":"使","348cd8e8fd82bf47":"申","b9c8f9c4641de012":"都","978eb2dc583ccda4":"击","935d429ac6a3c11b":"选","e0d5c347717fb989":"负","99da3a2352c59e24":"附","27b6e7d307cf7a74":"是","95ebd19e70c08223":"用","6d7c719bf8d3befc":"事","e4eed59e88051832":"细","9e016c3b507a33fb":"务","2789a9d38d93a6e5":"开","14aac19c38b9b018":"始","3bed98a854cc8e6c":"去","06f58a055f49b6e6":"泽","260400b22ffd1f6e":"样","daaff84c6367c9f4":"肠","d467b21c4ed17a9a":"续","9e6af8a70cdc9d3b":"马","84a4157bf76bd8f0":"留","bd55af88a943b291":"阶","fc574c842ab935df":"每","9130bf045432bed2":"弹","45c1201ebdc3e649":"如","b1614b3cf3df0521":"简","39d86379e08fd0dd":"按","84ebcb91bd7e49c3":"战","6344c1b00662465b":"热","5e171877d3909a88":"较","d4cdbb6b4a46e3b2":"值","5d711ff801b49b35":"阴","689bb5532e7157d7":"肌","d8e559f7365d5b1b":"融","353acddb7e318a5b":"艺","9a56067ec3c3678c":"治","621295315fca7726":"引","d733bb666c8a80f8":"析","06f19232f25f9ea9":"索","af765b7548e87f8f":"距","2673bce259a8d5fa":"股","4781b5af1fd7dcc9":"察","8780050bd707bf17":"社","314232fb5abf6ca5":"行","32a2d20d045bd3c9":"氨","867777dc4763c9d1":"着","d63c8a1904c1ba4e":"压","e6fa707f164f3d5c":"假","02b051b1c57ee0d5":"筑","21b1978fd37fba0c":"表","f0a01d51be149a11":"运","41f4ad80dd2d091e":"函","ee9ecc4756e45cb5":"主","a97c8fb1fb14919e":"达","e81e273f7d4e06ef":"土","80a1d3f2c06b4b22":"损","94a22334e38b6d16":"呼","1ac5d8437fcdf55b":"良","58228ca8028e2141":"衡","c7b997542a029810":"把","b48f260f1f7e0cc5":"执","d74da2e8001e0f70":"级","980c64deef7196cb":"船","fc2ce50e6eaf32c7":"肿","ecd43185ba880a50":"尔","cc346a495875e188":"具","789db2d2da960cf3":"超","0783b09896b2a018":"影","1bfa382ed461971a":"售","a10464e7696318cc":"移","1170a1a7fd86a85d":"糖","8aca588a579e7dfe":"慢","c48bdc3d84fdda1d":"助","faa6d45ecd4bee09":"李","ef94ef7a0fc8d511":"上","451bb0a163cfa58e":"局","1308f9c14c5a9390":"几","47873cb72331a897":"我","d427f0d969e63714":"管","f539c1a59f048fe5":"不","97fa97e254d96dba":"建","f03cce87a8bca7b8":"深","7bc155b8bc93ff5e":"长","1b9e889999ae635c":"又","91286e3d0d01eed2":"混","f1775c8af1b52d7d":"止","1c5d81f34092e508":"它","d7b01704e3be8abf":"承","0728b12372873d7f":"氧","a34f81db1e3bcdbe":"盾","41eb54846841859b":"活","8a2472c96617ceba":"周","35bfd16f3487f0c0":"还","b67b46cf2f9e0f53":"带","ecb1692558610f58":"综","c6e70e4a6534518b":"调","3d9e1f33600700ed":"纤","bc0064507231d8de":"变","e41a227487f096fa":"民","cc7c383f7a374b84":"病","68a38dc9b9b970eb":"独","83504672db0eec5d":"疫","86377dfd913fc587":"备","02641ff4f3339206":"实","448add41fd233607":"车","6a4f1fa1d7fa1ea7":"施","e14eaf095c59c544":"会","885e522e6cee55e5":"南","6ab26666afc7a823":"色","a2bacd4f356ee577":"型","e53100c6e6ba01e8":"给","bcfc30c7b0f12abf":"界","1117dfc47ecdd1e0":"阳","6fba08570dd21ad5":"师","9337bea3f0a7ef83":"老","378d275cf8201c6a":"哪","7ffd097c9ee55ae1":"案","a9612bb1db864c3f":"校","7e23036dfc654a2c":"黄","c1a18fd25f977f82":"操","296a4eea0048886f":"团","7beadf9cb763b83f":"办","8c2992493b2786cf":"角","1f85c13c4929f851":"张","61572a6145ee9021":"成","6754807c9b99a253":"太","09537d89b815584d":"址","e35b138547937e33":"修","f62b66782e3895f2":"符","ef5fb52bb3ccfa02":"策","37d0be615fee4142":"药","966b5638344d7d59":"显","a4b62e97a925bec3":"评","ff19d799701301b0":"王","7ba4e4c423bb0983":"感","8cefee2d4fdbc42d":"卡","bfcffe27ea68aad8":"从","2613f24925cc56c4":"患","ba8cf89bd665d683":"原","d0fc14cf96f21bf1":"觉","5460b73b9e34ffeb":"经","0c8243c12e845c27":"自","4304ac4d600f199c":"突","4203e374f6ac4c1a":"落","612a1840f211f103":"度","388dea9d879f4f0a":"乐","30d3710940847228":"米","b6f92afc8985aff2":"购","7ca3233491054e26":"释","ea6c966f75f1d3f1":"雅","a3788e8fe52659aa":"消","12b1925e14401704":"均","29c01fdcaa8433f8":"降","862beacfd9057fb7":"球","3d9f76e1a5e730ec":"借","433ed984a5f5e08c":"时","99e34234bf0a98ba":"有","2724880c4a806c38":"之","bb079ee1bc91b40e":"端","d450f96aad926b82":"十","0a09b4826ce67209":"免","ba3d487fdc2545b9":"量","e850cd6402c48f81":"项","f67deb27a0150ac1":"总","d4d33beeba2dd5d3":"注","dc70ac158a718b8c":"视","adb5f0b78d2ffbc9":"话"};

  function loadExternalScriptOnce(src, globalName, stateKey) {
    const hostWindow = getPageHostWindow();
    if (hostWindow[globalName]) return Promise.resolve(hostWindow[globalName]);
    if (externalLoaderState[stateKey]) return externalLoaderState[stateKey];

    externalLoaderState[stateKey] = new Promise((resolve, reject) => {
      const script = hostWindow.document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => {
        if (hostWindow[globalName]) {
          resolve(hostWindow[globalName]);
        } else {
          reject(new Error(`script loaded but missing global ${globalName}`));
        }
      };
      script.onerror = () => reject(new Error(`failed to load script: ${src}`));
      hostWindow.document.head.appendChild(script);
    });

    return externalLoaderState[stateKey];
  }

  function withTimeout(promise, ms, label = 'timeout') {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label)), ms);
      Promise.resolve(promise).then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  async function ensureFontDecodeDependencies() {
    const hostWindow = getPageHostWindow();
    if (!hostWindow.opentype) {
      await withTimeout(
        loadExternalScriptOnce('https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.min.js', 'opentype', 'opentype'),
        15000,
        'load opentype.js timeout'
      );
    }
  }

  function normalizeDecodedText(text) {
    let normalized = String(text || '').replace(/\r/g, '');
    const collapseChineseSpacing = (value) => {
      let output = value;
      let previous = '';
      while (output !== previous) {
        previous = output;
        output = output
          .replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, '$1$2')
          .replace(/([\u4e00-\u9fff])\s+([()\uFF08\uFF09,.\uFF0C\u3002\u3001\u201C\u201D\u300A\u300B\u3010\u3011])/g, '$1$2')
          .replace(/([()\uFF08\uFF09,.\uFF0C\u3002\u3001\u201C\u201D\u300A\u300B\u3010\u3011])\s+([\u4e00-\u9fff])/g, '$1$2')
          .replace(/([A-D])\s+([\u4e00-\u9fff])/g, '$1 $2');
      }
      return output;
    };

    normalized = normalized
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ ]{2,}/g, ' ');

    const lines = normalized
      .split('\n')
      .map(line => collapseChineseSpacing(line.trim()))
      .filter(line => line)
      .filter(line => !/^(\u4e0a\u4e00\u9898|\u4e0b\u4e00\u9898|\u63d0\u4ea4)$/u.test(line))
      .filter(line => !/^\u4e0a[\s-]*\u4e00[\s-]*\u9898[\s-]*\u4e0b[\s-]*\u4e00[\s-]*\u9898$/u.test(line))
      .filter(line => !/^\u4e0a[\s-]*[-\u662f\u4e00]*[\s-]*\u4e0b[\s-]*[-\u662f\u4e00]*$/u.test(line));

    return lines.join('\n')
      .replace(/[\uFF08(]\s+/g, '(')
      .replace(/\s+[\uFF09)]/g, ')')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function cleanupDecodedOptionText(text) {
    const normalized = normalizeDecodedText(text)
      .replace(/^[|!Iil\[\]\uFF1F\u003F\uFF08\uFF09()O0Q\s]+/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (/^[A-Za-z][A-Za-z\s="'`~_-]{1,12}$/.test(normalized)) {
      return '';
    }
    return normalized;
  }

  function stripDuplicatedOptionPrefix(text, letter = '') {
    let output = String(text || '').trim();
    const normalizedLetter = String(letter || '').trim();
    if (!output) return '';
    if (!normalizedLetter) return output;

    output = output
      .replace(new RegExp(`^${normalizedLetter}[\\s.、:：)）]+`, 'i'), '')
      .replace(new RegExp(`^${normalizedLetter}(?=[\\u4e00-\\u9fffA-Za-z0-9])`, 'i'), '');

    return output.trim();
  }

  function normalizeOptionCompareText(text) {
    return String(text || '')
      .replace(/^[A-F][\s.、:：)）]*/i, '')
      .replace(/\s+/g, '')
      .replace(/[()（）【】\[\]“”"'‘’·,，。；;：:、\-—]/g, '')
      .trim();
  }

  function mergeWrappedQuestionSuffix(lines) {
    const merged = [];
    for (const rawLine of lines) {
      const line = String(rawLine || '').trim();
      if (!line) continue;
      if (/^[（(]\s*[）)]$/.test(line) && merged.length) {
        merged[merged.length - 1] += '()';
        continue;
      }
      merged.push(line);
    }
    return merged;
  }

  function cleanupDecodedStemText(text) {
    const normalized = normalizeDecodedText(text);
    if (!normalized) return '';
    const lines = mergeWrappedQuestionSuffix(normalized
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean));

    const filtered = [];
    for (const line of lines) {
      if (/^[A-F]$/.test(line)) break;
      if (/^[A-F][\s.、:：)）]/.test(line)) break;
      if (/^[A-F](?=[\u4e00-\u9fffA-Za-z0-9])/.test(line)) break;
      filtered.push(line);
    }
    return filtered.join('\n').trim();
  }

  function normalizeFontFamilyName(value) {
    return String(value || '')
      .split(',')[0]
      .replace(/["']/g, '')
      .trim()
      .toLowerCase();
  }

  function getEncryptedFontInfo(element) {
    if (!element || !element.ownerDocument) return { family: 'exam-data-decrypt-font', src: '', signature: 'exam-data-decrypt-font|' };
    const doc = element.ownerDocument;
    const family = normalizeFontFamilyName(window.getComputedStyle(element).fontFamily) || 'exam-data-decrypt-font';
    let src = '';

    for (const styleSheet of Array.from(doc.styleSheets || [])) {
      let rules = null;
      try {
        rules = styleSheet.cssRules;
      } catch (error) {
        continue;
      }
      if (!rules) continue;

      for (const rule of Array.from(rules)) {
        if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
        const ruleFamily = normalizeFontFamilyName(rule.style.getPropertyValue('font-family'));
        if (ruleFamily !== family) continue;
        const srcText = String(rule.style.getPropertyValue('src') || '').trim();
        const urlMatch = srcText.match(/url\((['"]?)(.*?)\1\)/i);
        src = urlMatch ? urlMatch[2] : srcText;
        if (src) break;
      }
      if (src) break;
    }

    return { family, src, signature: `${family}|${src}` };
  }

  function getGlyphPathSignature(font, glyph) {
    const commands = glyph.getPath(0, 0, font.unitsPerEm).commands;
    const parts = [];
    for (const cmd of commands) {
      parts.push(cmd.type);
      if ('x' in cmd) {
        parts.push(Number(cmd.x).toFixed(3));
        parts.push(Number(cmd.y).toFixed(3));
      }
      if ('x1' in cmd) {
        parts.push(Number(cmd.x1).toFixed(3));
        parts.push(Number(cmd.y1).toFixed(3));
      }
      if ('x2' in cmd) {
        parts.push(Number(cmd.x2).toFixed(3));
        parts.push(Number(cmd.y2).toFixed(3));
      }
    }
    return parts.join('|');
  }

  function fnv1a64(text) {
    let hash = 0xcbf29ce484222325n;
    const bytes = new TextEncoder().encode(String(text || ''));
    for (const byte of bytes) {
      hash ^= BigInt(byte);
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, '0');
  }

  async function ensureFontCharMap(fontInfo) {
    if (!fontInfo || !fontInfo.signature) return new Map();
    if (encryptedGlyphState.fontMaps.has(fontInfo.signature)) {
      return encryptedGlyphState.fontMaps.get(fontInfo.signature);
    }
    if (encryptedGlyphState.fontLoads.has(fontInfo.signature)) {
      return encryptedGlyphState.fontLoads.get(fontInfo.signature);
    }

    const loadPromise = (async () => {
      const charMap = new Map();
      try {
        if (!fontInfo.src) throw new Error('missing font url');
        await ensureFontDecodeDependencies();
        const hostWindow = getPageHostWindow();
        const opentype = hostWindow.opentype || window.opentype;
        if (!opentype) throw new Error('opentype.js not ready');

        const response = await withTimeout(fetch(fontInfo.src, { credentials: 'omit' }), 15000, 'download font timeout');
        if (!response.ok) throw new Error(`download font failed: ${response.status}`);
        const buffer = await withTimeout(response.arrayBuffer(), 15000, 'read font timeout');
        const font = opentype.parse(buffer);
        const cmap = font?.tables?.cmap?.glyphIndexMap || font?.encoding?.cmap?.glyphIndexMap || {};

        for (const cpStr of Object.keys(cmap)) {
          const fakeChar = String.fromCodePoint(Number(cpStr));
          const glyphIndex = cmap[cpStr];
          const glyph = font.glyphs.get(glyphIndex);
          if (!glyph) continue;
          const glyphHash = fnv1a64(getGlyphPathSignature(font, glyph));
          const realChar = EXAM_FONT_GLYPH_HASH_MAP[glyphHash];
          if (realChar) charMap.set(fakeChar, realChar);
        }
      } catch (error) {
        const hostWindow = getPageHostWindow();
        hostWindow.__yktDecryptLastError = String(error && error.message ? error.message : error);
        console.log('font decrypt failed', error);
      }
      encryptedGlyphState.fontMaps.set(fontInfo.signature, charMap);
      encryptedGlyphState.fontLoads.delete(fontInfo.signature);
      return charMap;
    })();

    encryptedGlyphState.fontLoads.set(fontInfo.signature, loadPromise);
    return loadPromise;
  }

  function isEncryptedGlyphElement(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.classList.contains('xuetangx-com-encrypted-font')) return true;
    const family = window.getComputedStyle(element).fontFamily || '';
    return /exam-data-decrypt-font/i.test(family);
  }

  function getEncryptedLeafElements(root) {
    if (!root || root.nodeType !== 1) return [];
    const nodes = [root, ...root.querySelectorAll('*')].filter(node => isEncryptedGlyphElement(node));
    return nodes.filter(node => !Array.from(node.querySelectorAll('*')).some(child => isEncryptedGlyphElement(child)));
  }

  function isDecryptableChar(ch) {
    return !!ch && !/\s/.test(ch);
  }

  function decodeTextByCharMap(text, charMap) {
    return Array.from(String(text || '')).map(ch => {
      if (!isDecryptableChar(ch)) return ch;
      return charMap.get(ch) || ch;
    }).join('');
  }

  function countUnknownDecryptChars(text, charMap) {
    let count = 0;
    for (const ch of Array.from(String(text || ''))) {
      if (!isDecryptableChar(ch)) continue;
      if (!charMap.has(ch)) count += 1;
    }
    return count;
  }

  async function decodeEncryptedElement(element) {
    if (!element) return '';
    const encryptedText = String(element.innerText || element.textContent || '');
    const fontInfo = getEncryptedFontInfo(element);
    const charMap = await ensureFontCharMap(fontInfo);
    const decodedByMap = decodeTextByCharMap(encryptedText, charMap);
    if (countUnknownDecryptChars(encryptedText, charMap) > 0) {
      const hostWindow = getPageHostWindow();
      hostWindow.__yktDecryptLastMiss = {
        font: fontInfo.signature,
        sample: encryptedText,
        unresolved: Array.from(new Set(Array.from(encryptedText).filter(ch => isDecryptableChar(ch) && !charMap.has(ch)))).join('')
      };
    }
    return normalizeQuestionText(decodedByMap);
  }
  function normalizeQuestionText(text) {
    return String(text || '')
      .replace(/上一题|下一题|已提交|收起解析|查看解析/g, '')
      .replace(/^\s*[\r\n]/gm, '')
      .trim();
  }
  async function getDecodedInnerText(element) {
    if (!element) return '';
    const mainDoc = element.ownerDocument || window.parent.document;
    const encryptedLeaves = getEncryptedLeafElements(element);
    if (encryptedLeaves.length === 0) {
      return normalizeQuestionText(element.innerText || element.textContent || '');
    }

    const clone = element.cloneNode(true);
    const cloneEncryptedLeaves = getEncryptedLeafElements(clone);
    for (let i = 0; i < encryptedLeaves.length; i++) {
      const originalNode = encryptedLeaves[i];
      const cloneNode = cloneEncryptedLeaves[i];
      if (!cloneNode) continue;
      cloneNode.textContent = await decodeEncryptedElement(originalNode);
      cloneNode.classList.remove('xuetangx-com-encrypted-font');
      cloneNode.style.fontFamily = 'inherit';
    }

    const sandbox = mainDoc.createElement('div');
    sandbox.style.cssText = 'position:fixed;left:-99999px;top:-99999px;opacity:0;pointer-events:none;white-space:pre-wrap;';
    sandbox.appendChild(clone);
    mainDoc.body.appendChild(sandbox);
    const decodedText = normalizeQuestionText(clone.innerText || clone.textContent || '');
    mainDoc.body.removeChild(sandbox);
    return decodedText;
  }

  async function extractQuestionTextFromContainer(container, mainDoc = window.parent.document) {
    if (!container) return '';
    const itemType = container.querySelector('.item-type');
    const score = container.querySelector('.item-score, .problem-score, .score, .question-score');
    const stem = container.querySelector('.problem-body, .item-body, .question-body, .question-content');
    const labels = Array.from(container.querySelectorAll('label.el-radio, label.el-checkbox, label.homeworkElRadio, label.homeworkElCheckbox'));
    const remark = container.querySelector('.problem-remark, .problem-grade, .analysis, .answer-analysis');
    const parts = [];

    if (itemType) {
      const typeText = await getDecodedInnerText(itemType);
      if (typeText) parts.push(typeText);
    }

    if (score) {
      const scoreText = await getDecodedInnerText(score);
      if (scoreText) parts.push(scoreText);
    }

    if (stem) {
      const stemText = cleanupDecodedStemText(await getDecodedInnerText(stem));
      if (stemText) parts.push(stemText);
    }

    for (const label of labels) {
      const letter = ((label.querySelector('.radioInput, .checkboxInput, .option-index, .label-index')?.textContent || '').split('\n')[0] || '').trim();
      const textNode = label.querySelector('.radioText, .checkboxText, .option-text, .el-radio__label, .el-checkbox__label') || label;
      const optionText = stripDuplicatedOptionPrefix(
        cleanupDecodedOptionText(await getDecodedInnerText(textNode)),
        letter
      );
      if (!optionText || (letter && optionText === letter)) continue;
      if (optionText) {
        parts.push(`${letter || ''} ${optionText}`.trim());
      }
    }

    if (remark) {
      const remarkText = await getDecodedInnerText(remark);
      if (remarkText) parts.push(remarkText);
    }

    const structuredText = normalizeDecodedText(parts.join('\n'));
    if (structuredText) return structuredText;
    return await getDecodedInnerText(container);
  }

  function extractStemFromQuestionText(text) {
    const lines = String(text || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    const stemParts = [];
    let startIndex = 0;
    if (lines[0] && /^\d+\.\s*\S+题/.test(lines[0])) startIndex = 1;
    if (lines[startIndex] && /^\(\d+分\)$/.test(lines[startIndex])) startIndex += 1;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      if (/^[A-F][\s.、]/.test(line)) break;
      if (/^(本题得分|正确答案|填空\d+[：:]|解析[:：])/.test(line)) break;
      stemParts.push(line);
    }

    return stemParts.join(' ').trim();
  }

  async function submitCurrentAnswer(targetDoc, mainDoc, questionIndex, opts) {
    var runtime = window.parent.$;
    var mode = opts && opts.mode ? opts.mode : 'question';
    var submitSelectors = ['.submit-btn', '.btn-submit', 'button.submit', '.el-button--primary', '.homework-submit', '.paper-submit', 'button[type="submit"]'];
    var submitTexts = mode === 'final' ? ['交卷', '提交'] : ['提交'];
    var submitted = false;

    function textMatches(btnText) {
      return submitTexts.some(function(t) { return btnText.indexOf(t) !== -1; });
    }

    var buttons = Array.from(new Set([targetDoc, mainDoc].flatMap(function(sourceDoc) {
      return submitSelectors.flatMap(function(selector) {
        return Array.from(sourceDoc.querySelectorAll(selector));
      });
    })));
    buttons.sort(function(left, right) {
      var score = function(btn) { return /交卷|提交试卷|提交作业/.test(btn.innerText || btn.textContent || '') ? 1 : 0; };
      return score(right) - score(left);
    });
    for (var btn of buttons) {
      var btnText = (btn.innerText || btn.textContent || '').trim();
      if (!btnText || !textMatches(btnText)) continue;
      if (btn.disabled || btn.getAttribute('disabled') !== null || /已提交|已交|已完成/.test(btnText) || !btn.getClientRects().length) continue;

      btn.click();
      submitted = true;
      runtime.alertMessage(mode === 'final'
        ? '📤 已点击最终提交按钮'
        : ('📤 第 ' + questionIndex + ' 题已点击提交按钮'));

      await new Promise(function(r) { setTimeout(r, 1200); });

      var confirmSelectors = ['.el-message-box__btns button', '.el-dialog__footer button', '.modal-footer button', 'button.confirm', '.confirm-btn'];
      var confirmButtons = Array.from(new Set([targetDoc, mainDoc].flatMap(function(sourceDoc) {
        return confirmSelectors.flatMap(function(selector) {
          return Array.from(sourceDoc.querySelectorAll(selector));
        });
      })));
      for (var confirmBtn of confirmButtons) {
        var confirmText = (confirmBtn.innerText || confirmBtn.textContent || '').trim();
        if (confirmBtn.getClientRects().length && !confirmBtn.disabled &&
            confirmText && /交卷|确定|确认|提交/.test(confirmText) && !/继续作答|取消/.test(confirmText)) {
          confirmBtn.click();
          runtime.alertMessage(mode === 'final'
            ? '✅ 已确认最终提交'
            : ('✅ 第 ' + questionIndex + ' 题已确认提交'));
          await new Promise(function(r) { setTimeout(r, 1200); });
          break;
        }
      }
      break;
    }

    return submitted;
  }

  const AI_SETTINGS_KEY = '[雨课堂脚本]AI接口';
  const AI_SUBMIT_KEY = '[雨课堂脚本]AI自动提交';
  const DEFAULT_AI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
  let sessionAiKey = '';

  function readAiSettings() {
    const saved = GM_getValue(AI_SETTINGS_KEY, {});
    return {
      endpoint: typeof saved?.endpoint === 'string' ? saved.endpoint : DEFAULT_AI_ENDPOINT,
      model: typeof saved?.model === 'string' ? saved.model : '',
      apiKey: sessionAiKey || (typeof saved?.apiKey === 'string' ? saved.apiKey : ''),
      allowInsecureHttp: saved?.allowInsecureHttp === true
    };
  }

  function validateAiEndpoint(value, allowInsecureHttp = false) {
    let endpoint;
    try {
      endpoint = new URL(value);
    } catch (_) {
      throw new Error('请输入完整的接口地址');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (endpoint.protocol === 'http:' && !loopback && !allowInsecureHttp) {
      throw new Error('远程 HTTP 会明文传输题目和密钥；如确需使用，请勾选允许远程 HTTP');
    }
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
      throw new Error('接口地址只能使用 HTTPS 或 HTTP');
    }
    if (endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error('接口地址不能包含账户、密码或片段');
    }
    return endpoint.href;
  }

  function updateAiStatus(settings, message) {
    const storedKey = GM_getValue(AI_SETTINGS_KEY, {})?.apiKey;
    let host = '';
    try { host = new URL(settings?.endpoint).host; } catch (_) { /* 地址验证时会给出错误。 */ }
    aiStatus.textContent = message || (settings.model
      ? `AI：${settings.model} → ${host}${settings.allowInsecureHttp ? '，HTTP 明文' : ''}${storedKey ? '，密钥已保存' : settings.apiKey ? '，会话密钥已设置' : '，未设置密钥'}`
      : '请填写模型名称并保存接口');
  }

  const initialAiSettings = readAiSettings();
  aiEndpoint.value = initialAiSettings.endpoint;
  aiModel.value = initialAiSettings.model;
  rememberAiKey.checked = !!GM_getValue(AI_SETTINGS_KEY, {})?.apiKey;
  allowHttp.checked = initialAiSettings.allowInsecureHttp;
  updateAiStatus(initialAiSettings);
  autoSubmit.checked = window.parent.localStorage.getItem(AI_SUBMIT_KEY) === 'true';
  autoSubmit.addEventListener('change', () => {
    window.parent.localStorage.setItem(AI_SUBMIT_KEY, autoSubmit.checked ? 'true' : 'false');
  });
  toggleAiKey.addEventListener('click', () => {
    const visible = aiKey.type === 'password';
    aiKey.type = visible ? 'text' : 'password';
    toggleAiKey.textContent = visible ? '隐藏' : '显示';
    toggleAiKey.setAttribute('aria-label', visible ? '隐藏密钥' : '显示密钥');
  });
  function hideAiKey() {
    aiKey.type = 'password';
    toggleAiKey.textContent = '显示';
    toggleAiKey.setAttribute('aria-label', '显示密钥');
  }
  clearAiKey.addEventListener('click', () => {
    const settings = readAiSettings();
    settings.apiKey = '';
    sessionAiKey = '';
    GM_setValue(AI_SETTINGS_KEY, settings);
    aiKey.value = '';
    hideAiKey();
    rememberAiKey.checked = false;
    updateAiStatus(settings, '已清除密钥');
  });
  saveAiSettings.addEventListener('click', () => {
    try {
      const currentKey = aiKey.value.trim() || readAiSettings().apiKey;
      const settings = {
        endpoint: validateAiEndpoint(aiEndpoint.value.trim(), allowHttp.checked),
        model: aiModel.value.trim(),
        apiKey: rememberAiKey.checked ? currentKey : '',
        allowInsecureHttp: allowHttp.checked
      };
      if (!settings.model) throw new Error('请填写模型名称');
      GM_setValue(AI_SETTINGS_KEY, settings);
      sessionAiKey = rememberAiKey.checked ? '' : currentKey;
      aiKey.value = '';
      hideAiKey();
      updateAiStatus(readAiSettings());
    } catch (error) {
      updateAiStatus(null, error.message);
      aiSettings.open = true;
    }
  });

  async function readCurrentQuestion(targetDoc, questionElement = null) {
    const cp = questionElement || Array.from(targetDoc.querySelectorAll('.container-problem, .exercise-item'))
      .find(node => node.getClientRects().length > 0) || targetDoc.querySelector('.container-problem, .exercise-item');
    if (!cp) throw new Error('未找到题目容器');
    const typeText = await getDecodedInnerText(cp.querySelector('.item-type'));
    const questionText = await extractQuestionTextFromContainer(cp, targetDoc);
    const examStem = cp.classList.contains('exercise-item') ? cp.querySelector('.item-body > h4') : null;
    const stem = (examStem && await getDecodedInnerText(examStem)) || extractStemFromQuestionText(questionText) ||
      await getDecodedInnerText(cp.querySelector('.problem-body, .item-body'));
    if (!stem) throw new Error('未读取到题干');

    const labels = Array.from(cp.querySelectorAll('label.el-radio, label.el-checkbox, label.homeworkElRadio, label.homeworkElCheckbox'));
    if (/投票/.test(typeText) && !labels.length) {
      for (const label of cp.querySelectorAll('label')) {
        if (label.querySelector('input[type="radio"], input[type="checkbox"]')) labels.push(label);
      }
    }
    if (labels.length > 26) throw new Error('选项数量超出支持范围');
    const options = await Promise.all(labels.map(async (label, index) => {
      const optionBody = label.querySelector('.radioText, .checkboxText, .option-text') || label;
      let text = (await getDecodedInnerText(optionBody)).trim();
      const input = label.querySelector('input[type="radio"], input[type="checkbox"]');
      const icon = label.querySelector('use')?.getAttribute('xlink:href') || label.querySelector('use')?.getAttribute('href') || '';
      if (!text && /zhengque|correct|dui/i.test(icon)) text = '正确';
      if (!text && /cuowu|wrong|false/i.test(icon)) text = '错误';
      if (!text && /^(true|false)$/i.test(input?.value || '')) text = input.value.toLowerCase() === 'true' ? '正确' : '错误';
      return { letter: String.fromCharCode(65 + index), text };
    }));
    const inputs = Array.from(cp.querySelectorAll('input[type="text"], textarea, .el-input__inner, .el-textarea__inner'))
      .filter(input => !input.disabled && input.getClientRects().length > 0);
    const essayEditors = Array.from(cp.querySelectorAll('[contenteditable="true"]'))
      .filter(editor => editor.getClientRects().length > 0);
    for (const iframe of cp.querySelectorAll('iframe')) {
      try {
        const body = iframe.contentDocument?.body;
        if (iframe.getClientRects().length > 0 && body?.isContentEditable) essayEditors.push(body);
      } catch (_) { /* 跨域编辑器不可直接填写。 */ }
    }
    const kind = /主观|简答|论述|问答/.test(typeText) ? 'subjective'
      : /填空/.test(typeText) || (!labels.length && inputs.length) ? 'fill'
      : /多选|多项/.test(typeText) || (/投票/.test(typeText) && labels.some(label => label.querySelector('input[type="checkbox"]'))) ? 'multiple'
      : /判断/.test(typeText) ? 'judge' : 'single';
    if (kind === 'subjective' ? !inputs.length && !essayEditors.length : kind === 'fill' ? !inputs.length : !labels.length) {
      throw new Error('未找到可填写的答案控件');
    }
    return { cp, stem, typeText, kind, options, labels, inputs, essayEditors };
  }

  function parseAiAnswer(content) {
    const plain = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let answer;
    try {
      answer = JSON.parse(plain);
    } catch (_) {
      throw new Error('AI 返回内容不是有效 JSON，未填写本题');
    }
    if (!answer || typeof answer !== 'object') throw new Error('AI 返回的答案格式无效');
    return answer;
  }

  function requestAiAnswer(question, settings) {
    const prompt = {
      type: question.typeText,
      kind: question.kind,
      stem: question.stem.slice(0, 10000),
      options: question.options,
      blankCount: question.kind === 'fill' ? question.inputs.length : 0
    };
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
      GM_xmlhttpRequest({
        method: 'POST',
        url: settings.endpoint,
        redirect: 'error',
        headers,
        data: JSON.stringify({
          model: settings.model,
          stream: false,
          messages: [
            { role: 'system', content: '你是答题助手。只返回 JSON 对象，不要解释或 Markdown。单选、判断、单选投票返回 {"choices":["A"]}；多选和多选投票在 choices 中列出所有选项字母；填空题返回 {"blanks":["每一空的答案"]}；主观题返回 {"text":"简明完整的文字答案"}。选项字母只能从题目提供的选项中选择。' },
            { role: 'user', content: JSON.stringify(prompt) }
          ]
        }),
        timeout: 60000,
        onload: response => {
          if (response.status < 200 || response.status >= 300) {
            const hint = response.status === 401 ? '，请检查密钥'
              : response.status === 404 ? '，请检查接口地址和模型'
              : response.status === 429 ? '，请检查额度或稍后重试'
              : response.status === 400 ? '，请检查模型或接口兼容性' : '';
            reject(new Error(`AI 接口返回 HTTP ${response.status}${hint}`));
            return;
          }
          try {
            const payload = JSON.parse(response.responseText);
            const choice = payload?.choices?.[0];
            if (choice?.finish_reason === 'length') throw new Error('AI 输出被截断，未填写本题');
            if (choice?.finish_reason === 'content_filter') throw new Error('AI 输出被服务商拦截');
            const content = choice?.message?.content;
            const text = typeof content === 'string' ? content
              : Array.isArray(content) ? content.map(part => part?.text || '').join('') : '';
            resolve(parseAiAnswer(text));
          } catch (error) {
            reject(error instanceof SyntaxError ? new Error('AI 接口响应格式无效') : error);
          }
        },
        onerror: () => reject(new Error('AI 接口连接失败')),
        ontimeout: () => reject(new Error('AI 接口请求超时'))
      });
    });
  }

  function isOptionChecked(label) {
    const input = label.querySelector('input[type="radio"], input[type="checkbox"]');
    return !!(input?.checked || label.classList.contains('is-checked') ||
      label.querySelector('.is-checked') || label.getAttribute('aria-checked') === 'true');
  }

  function actAndWaitForExamSave(action) {
    if (location.hostname !== 'examination.xuetangx.com' || typeof PerformanceObserver === 'undefined') {
      action();
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let observer;
      let timer;
      const cleanup = () => {
        observer?.disconnect();
        clearTimeout(timer);
      };
      try {
        observer = new PerformanceObserver((list) => {
          if (list.getEntries().some(entry => {
            try { return new URL(entry.name).pathname.endsWith('/exam_room/answer_problem'); }
            catch (_) { return false; }
          })) {
            cleanup();
            setTimeout(resolve, 120);
          }
        });
        observer.observe({ type: 'resource' });
        timer = setTimeout(() => {
          cleanup();
          reject(new Error('答案保存未确认，请手动检查后再提交'));
        }, 10000);
        action();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  async function applyAiAnswer(question, answer) {
    if (question.kind === 'subjective') {
      const text = typeof answer.text === 'string' ? answer.text.trim() : '';
      if (!text || text.length > 10000) throw new Error('AI 返回的主观题答案为空或过长');
      if (!question.cp.isConnected) throw new Error('题目已切换，未填写过期答案');
      const control = question.inputs.find(input => input.tagName === 'TEXTAREA') ||
        question.essayEditors[0] || question.inputs[0];
      const view = control.ownerDocument.defaultView;
      await actAndWaitForExamSave(() => {
        if (control.isContentEditable) {
          control.textContent = text;
        } else {
          const prototype = control.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (setter) setter.call(control, text);
          else control.value = text;
        }
        for (const type of ['input', 'change', 'blur']) control.dispatchEvent(new view.Event(type, { bubbles: true }));
      });
      return `主观回答 ${text.length} 字`;
    }
    if (question.kind === 'fill') {
      if (!Array.isArray(answer.blanks) || answer.blanks.length !== question.inputs.length ||
          answer.blanks.some(value => typeof value !== 'string' || !value.trim())) {
        throw new Error('AI 返回的填空数量或内容不正确');
      }
      for (let index = 0; index < question.inputs.length; index++) {
        const input = question.inputs[index];
        const view = input.ownerDocument.defaultView;
        const prototype = input.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(input, answer.blanks[index].trim());
        else input.value = answer.blanks[index].trim();
        if (index === question.inputs.length - 1) {
          await actAndWaitForExamSave(() => {
            for (const type of ['input', 'change', 'blur']) input.dispatchEvent(new view.Event(type, { bubbles: true }));
          });
        } else {
          for (const type of ['input', 'change', 'blur']) input.dispatchEvent(new view.Event(type, { bubbles: true }));
        }
      }
      return `${question.inputs.length} 个空`;
    }

    if (!Array.isArray(answer.choices) || !answer.choices.length ||
        answer.choices.some(letter => typeof letter !== 'string' || !/^[A-Z]$/.test(letter))) {
      throw new Error('AI 返回的选项格式不正确');
    }
    const choices = Array.from(new Set(answer.choices));
    if (choices.length !== answer.choices.length ||
        (question.kind !== 'multiple' && choices.length !== 1) ||
        choices.some(letter => letter.charCodeAt(0) - 65 >= question.labels.length)) {
      throw new Error('AI 返回的选项不符合当前题型');
    }
    if (!question.cp.isConnected) throw new Error('题目已切换，未填写过期答案');
    const indexes = choices.map(letter => letter.charCodeAt(0) - 65);
    if (question.kind === 'multiple') {
      for (let index = 0; index < question.labels.length; index++) {
        if (isOptionChecked(question.labels[index]) !== indexes.includes(index)) {
          await actAndWaitForExamSave(() => question.labels[index].click());
        }
      }
    } else if (!isOptionChecked(question.labels[indexes[0]])) {
      await actAndWaitForExamSave(() => question.labels[indexes[0]].click());
    }
    return choices.join('、');
  }

  async function answerVisibleQuestion(targetDoc, settings, questionIndex, questionElement = null) {
    const question = await readCurrentQuestion(targetDoc, questionElement);
    const answer = await requestAiAnswer(question, settings);
    const current = await readCurrentQuestion(targetDoc, questionElement);
    if (!question.cp.isConnected || current.cp !== question.cp || current.stem !== question.stem) {
      throw new Error('题目已切换，未填写过期答案');
    }
    const filled = await applyAiAnswer(question, answer);
    window.parent.$.alertMessage(`第 ${questionIndex} 题已填写：${filled}`);
    return true;
  }

  async function autoAnswerQuestions(settings) {
    const mainDoc = window.parent.document;
    let targetDoc = mainDoc;
    for (const child of mainDoc.querySelectorAll('iframe')) {
      if (child.id === 'ykt-helper-iframe') continue;
      try {
        if (child.contentDocument?.querySelector('.container-problem, .exercise-item')) {
          targetDoc = child.contentDocument;
          break;
        }
      } catch (_) { /* 跨域 iframe 无法读取。 */ }
    }
    const examQuestions = Array.from(targetDoc.querySelectorAll('.exercise-item'))
      .filter(node => node.getClientRects().length > 0);
    const sidebar = examQuestions.length ? [] : Array.from(targetDoc.querySelectorAll('.subject-item.J_order, .answer-status, .question-list .btn, .nav-item, .question-nav .number'));
    const total = examQuestions.length || sidebar.length || 1;
    let filled = 0;
    let failed = 0;
    for (let index = 0; index < total; index++) {
      if (sidebar.length) {
        sidebar[index].click();
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      try {
        await answerVisibleQuestion(targetDoc, settings, index + 1, examQuestions[index] || null);
        filled++;
      } catch (error) {
        failed++;
        window.parent.$.alertMessage(`第 ${index + 1} 题失败：${error.message}`);
      }
      window.parent.$.alertMessage(`AI 答题进度：${index + 1}/${total}，已填写 ${filled}，失败 ${failed}`);
    }
    if (autoSubmit.checked && filled === total && failed === 0) {
      const submitted = await submitCurrentAnswer(targetDoc, mainDoc, total, { mode: 'final' });
      if (!submitted) window.parent.$.alertMessage('未找到交卷按钮，请手动提交');
    }
    window.parent.$.alertMessage(`AI 答题完成：已填写 ${filled}，失败 ${failed}`);
  }

  autoAnswer.addEventListener('click', async () => {
    const settings = readAiSettings();
    try {
      settings.endpoint = validateAiEndpoint(settings.endpoint, settings.allowInsecureHttp);
      if (!settings.model) throw new Error('请先在 AI 接口设置中填写模型名称并保存');
      if (!settings.apiKey && new URL(settings.endpoint).hostname === 'api.openai.com') {
        throw new Error('OpenAI 官方接口需要 API 密钥');
      }
    } catch (error) {
      updateAiStatus(settings, error.message);
      aiSettings.open = true;
      return;
    }
    autoAnswer.disabled = true;
    autoAnswer.classList.add('active');
    autoAnswer.textContent = 'AI 答题中…';
    try {
      await autoAnswerQuestions(settings);
    } catch (error) {
      window.parent.$.alertMessage(`AI 答题失败：${error.message}`);
    } finally {
      autoAnswer.disabled = false;
      autoAnswer.classList.remove('active');
      autoAnswer.textContent = 'AI 答题';
    }
  });

  // 鼠标移入窗口，暂停自动滚动
  (function () {
    let scrollTimer;
    scrollTimer = setInterval(function () {
      if (infoAlert.lastElementChild) infoAlert.lastElementChild.scrollIntoView({ behavior: "smooth", block: "end", inline: "nearest" });
    }, 500)
    infoAlert.addEventListener('mouseenter', () => {
      clearInterval(scrollTimer);
    })
    infoAlert.addEventListener('mouseleave', () => {
      scrollTimer = setInterval(function () {
        if (infoAlert.lastElementChild) infoAlert.lastElementChild.scrollIntoView({ behavior: "smooth", block: "end", inline: "nearest" });
      }, 500)
    })
  })();

  // 重定向 alertMessage 到 iframe
  $.panel = panel;
  $.alertMessage = function (message) {
    const li = doc.createElement('li');
    li.innerText = message;
    infoAlert.appendChild(li);
  };

  // 注册进度更新回调
  $._onProgressUpdate = function (p) {
    progressBar.classList.add('show');
    const done = p.completed + p.skipped;
    const percent = p.total > 0 ? Math.round((done / p.total) * 100) : 0;
    progressStats.innerText = `${done} / ${p.total}（完成${p.completed} 跳过${p.skipped}）`;
    progressFill.style.width = percent + '%';
    if (p.currentTitle) {
      progressCurrent.innerText = `▶ 正在处理：${p.currentTitle}`;
    } else if (done >= p.total && p.total > 0) {
      progressCurrent.innerText = '✅ 全部完成';
    }
  };
}

function start() {  // 脚本入口函数
  const url = location.host;
  const pathName = location.pathname.split('/');
  const matchURL = url + pathName[0] + '/' + pathName[1] + '/' + pathName[2];
  $.alertMessage(`正在为您匹配${matchURL}的处理逻辑...`);
  if (matchURL.includes('yuketang.cn/v2/web') || matchURL.includes('gdufemooc.cn/v2/web')) {
    const started = yuketang_v2();
    $.setRunning(started !== false);
    return started;
  } else if (matchURL.includes('yuketang.cn/pro/lms') || matchURL.includes('gdufemooc.cn/pro/lms')) {
    const started = yuketang_pro_lms();
    $.setRunning(started !== false);
    return started;
  } else {
    $.setRunning(false);
    $.panel.querySelector("#n_button").innerText = "开始刷课";
    $.alertMessage(`这不是刷课的页面哦，刷课页面的网址应该匹配 */v2/web/* 或 */pro/lms/*`)
    return false;
  }
}
// 油猴执行文件
// Runtime fixes for fragile DOM assumptions and undefined accesses.
$.observePause = function observePauseFixed() {
  const targetElement = document.getElementsByClassName('play-btn-tip')[0];
  if (!targetElement) {
    setTimeout(() => $.observePause(), 100);
    return false;
  }
  if ($.observer) {
    $.observer.disconnect();
  }
  $.observer = new MutationObserver((mutationsList) => {
    for (const mutation of mutationsList) {
      if (mutation.type === 'childList' && mutation.target === targetElement && targetElement.innerText === '播放') {
        if ($.isPaused()) {
          return;
        }
        document.querySelector('video')?.play();
        $.alertMessage('视频意外暂停，已恢复播放');
      }
    }
  });
  $.observer.observe(targetElement, { childList: true });
  if (!$.isPaused()) {
    document.querySelector('video')?.play();
  }
};

function isProgressDone(text = '') {
  return ['100%', '99%', '98%', '已完成'].some(flag => text.includes(flag));
}

function hasV2PlayableCourseList() {
  if (location.pathname.includes('/student-lesson-report/')) {
    return false;
  }

  const list = document.querySelector('.logs-list');
  if (!list) {
    return false;
  }

  return !!list.querySelector('.content-box section');
}

function yuketang_v2() {
  const baseUrl = location.href;
  let count = $.userInfo.getProgress(baseUrl).outside;
  let play = true;

  // 检测是否已在视频播放页面（URL含 /video-student/ 或 /video/）
  const isVideoPage = location.pathname.includes('/video-student/') || location.pathname.includes('/xcloud/video');
  if (isVideoPage) {
    $.alertMessage('检测到当前已在视频播放页面，直接播放当前视频');
    // 等待视频元素加载
    const waitAndPlay = () => {
      const video = document.querySelector('video');
      if (video) {
        $.videoDetail(video);
        try { $.ykt_speed(); } catch(e) { console.log('加速失败，使用默认方式', e); }
        try { $.claim(); } catch(e) { console.log('静音按钮未找到，已通过volume=0静音'); }
        $.observePause();
        $.alertMessage(`视频已开始播放，${basicConf.rate}倍速`);
        // 监控进度
        const progressTimer = setInterval(() => {
          if ($.isPaused()) return;
          const progressNode = document.querySelector('.progress-wrap .text');
          const progressText = progressNode?.innerHTML || '';
          if (isProgressDone(progressText)) {
            clearInterval(progressTimer);
            $.observer?.disconnect();
            $.alertMessage('当前视频播放完成');
            $.setRunning(false);
          }
        }, 5000);
      } else {
        $.alertMessage('等待视频加载...');
        setTimeout(waitAndPlay, 2000);
      }
    };
    setTimeout(waitAndPlay, 2000);
    return true;
  }

  if (!hasV2PlayableCourseList()) {
    $.alertMessage('当前页面没有可播放课程，可能是课堂回顾页或空课件页');
    $.setRunning(false);
    $.panel.querySelector('#n_button').innerText = '开始刷课';
    return false;
  }

  $.alertMessage(`检测到当前进度：第 ${count + 1} 节`);
  $.alertMessage('已匹配到 yuketang.cn/v2/web，开始处理');

  function finish() {
    $.alertMessage('课程播放完成');
    $.setRunning(false);
    $.panel.querySelector('#n_button').innerText = '刷完了';
    $.userInfo.removeProgress(baseUrl);
  }

  function advance(outside, inside = 0) {
    count = outside;
    $.userInfo.setProgress(baseUrl, outside, inside);
  }

  function main() {
    autoSlide(count).then(async () => {
      await $.waitWhilePaused();
      const list = Array.from(document.querySelector('.logs-list')?.children || []);
      
      // 更新总进度统计
      (function updateNavProgress() {
        let total = list.length;
        let skipped = 0;
        let completed = 0;

        for (let i = 0; i < list.length; i++) {
          const item = list[i];
          const course = item.querySelector('.content-box section');
          if (!course) continue;
          
          const classInfo = course.querySelector('.tag use')?.getAttribute('xlink:href') || 'piliang';
          const statusText = item.innerText || '';
          
          if (classInfo.includes('gonggao')) {
            skipped++;
          } else if (classInfo.includes('ketang')) {
            const skipKeywords = ['已签到', '缺勤', '签到', '未签到', '迟到'];
            if (skipKeywords.some(kw => statusText.includes(kw))) {
              skipped++;
            } else if (i < count) {
              completed++;
            }
          } else {
            if (statusText.includes('已完成') || statusText.includes('100%')) {
              completed++;
            } else if (i < count) {
              completed++;
            }
          }
        }
        
        let currentTitle = '';
        if (count < list.length) {
          const course = list[count].querySelector('.content-box section');
          currentTitle = course?.querySelector('h2')?.innerText || list[count].querySelector('h2')?.innerText || `第 ${count + 1} 节`;
        }
        
        $.updateProgress({
          total,
          completed,
          skipped,
          current: count,
          currentTitle
        });
      })();

      if (count >= list.length && play === true) {
        finish();
        return;
      }

      const currentNode = list[count];
      const course = currentNode?.querySelector('.content-box section');
      if (!course) {
        $.alertMessage(`第 ${count + 1} 节未加载完成，跳过`);
        advance(count + 1);
        main();
        return;
      }

      const classInfo = course.querySelector('.tag use')?.getAttribute('xlink:href') || 'piliang';
      $.alertMessage(`当前进度：第 ${count + 1} / ${list.length} 节`);

      if (classInfo.includes('shipin') && play === true) {
        play = false;
        course.click();
        setTimeout(() => {
          const progressNode = document.querySelector('.progress-wrap .text');
          const title = document.querySelector('.title')?.innerText || `第 ${count + 1} 节`;
          const deadline = document.querySelector('.box')?.innerText?.includes('已过考核截止时间');
          $.alertMessage(`正在播放：${title}`);
          if (deadline) {
            $.alertMessage(`${title} 已过截止时间，跳过`);
          }
          $.ykt_speed();
          $.claim();
          $.observePause();
          const timer1 = setInterval(() => {
            if ($.isPaused()) {
              return;
            }
            const progressText = progressNode?.innerHTML || '';
            if (isProgressDone(progressText) || deadline) {
              clearInterval(timer1);
              play = true;
              advance(count + 1);
              $.observer?.disconnect();
              history.back();
              main();
            }
          }, 10000);
        }, 3000);
        return;
      }

      if (classInfo.includes('piliang') && play === true) {
        const expandBtn = course.querySelector('.sub-info .gray span');
        if (!expandBtn) {
          $.alertMessage(`第 ${count + 1} 节未找到批量展开按钮，跳过`);
          advance(count + 1);
          main();
          return;
        }

        expandBtn.click();
        setTimeout(() => {
          const activities = Array.from(list[count]?.querySelector('.leaf_list__wrap')?.querySelectorAll('.activity__wrap') || []);
          let inside = $.userInfo.allInfo?.[baseUrl]?.inside || 0;
          $.alertMessage(`第 ${count + 1} 节进入批量区`);

          const playInside = () => {
            if (inside >= activities.length) {
              $.alertMessage('批量区播放完成');
              advance(count + 1);
              main();
              return;
            }

            const currentItem = activities[inside];
            const tag = currentItem?.querySelector('.tag');
            if (!currentItem || !tag) {
              $.alertMessage(`批量区第 ${inside + 1} 项无法识别，跳过`);
              inside++;
              advance(count, inside);
              playInside();
              return;
            }

            const href = tag.querySelector('use')?.getAttribute('xlink:href') || '';
            const title = currentItem.querySelector('h2')?.innerText || `第 ${inside + 1} 项`;
            const isVideo = href.includes('shipin');
            const isAudio = !href;

            if (isAudio) {
              currentItem.click();
              $.alertMessage(`开始播放音频：${title}`);
              setTimeout(() => $.audioDetail(), 3000);
              const timer = setInterval(() => {
                if ($.isPaused()) {
                  return;
                }
                const progressText = document.querySelector('.progress-wrap .text')?.innerHTML || '';
                const audio = document.querySelector('audio');
                if (!$.isPaused() && audio?.paused) {
                  audio.play();
                }
                if (isProgressDone(progressText) || audio?.ended) {
                  clearInterval(timer);
                  inside++;
                  advance(count, inside);
                  $.alertMessage(`${title} 播放完成`);
                  history.back();
                  setTimeout(playInside, 2000);
                }
              }, 3000);
              return;
            }

            if (isVideo) {
              currentItem.click();
              $.alertMessage(`开始播放视频：${title}`);
              setTimeout(() => {
                $.ykt_speed();
                $.claim();
                $.observePause();
              }, 3000);
              const timer = setInterval(() => {
                if ($.isPaused()) {
                  return;
                }
                const progressText = document.querySelector('.progress-wrap .text')?.innerHTML || '';
                if (isProgressDone(progressText)) {
                  clearInterval(timer);
                  inside++;
                  advance(count, inside);
                  $.alertMessage(`${title} 播放完成`);
                  $.observer?.disconnect();
                  history.back();
                  setTimeout(playInside, 2000);
                }
              }, 3000);
              return;
            }

            $.alertMessage(`批量区第 ${inside + 1} 项不是音视频，跳过`);
            inside++;
            advance(count, inside);
            playInside();
          };

          playInside();
        }, 2000);
        return;
      }

      // 公告类型直接跳过，无需处理
      if (classInfo.includes('gonggao') && play === true) {
        $.alertMessage(`第 ${count + 1} 节是公告，跳过`);
        advance(count + 1);
        main();
        return;
      }

      if (classInfo.includes('ketang') && play === true) {
        // 先检查课堂条目右侧的状态标签，纯签到/缺勤/已签到的课堂没有视频
        const statusNode = currentNode?.querySelector('.completion, .right-side, .status');
        const statusText = statusNode?.innerText || currentNode?.innerText || '';
        const skipKeywords = ['已签到', '缺勤', '签到', '未签到', '迟到'];
        const shouldSkip = skipKeywords.some(kw => statusText.includes(kw));

        if (shouldSkip) {
          $.alertMessage(`第 ${count + 1} 节是课堂签到（${statusText.trim().substring(0, 10)}），直接跳过`);
          advance(count + 1);
          main();
          return;
        }

        $.alertMessage(`第 ${count + 1} 节进入课堂区`);
        play = false;
        course.click();
        const waitForMediaEnd = (media) => new Promise((resolve) => {
          if (!media || media.ended) {
            resolve();
            return;
          }
          media.addEventListener('ended', resolve, { once: true });
        });

        const getLessonMedia = () => {
          const docs = [document];
          const iframeList = Array.from(document.querySelectorAll('iframe'));

          iframeList.forEach((iframe) => {
            try {
              if (iframe.contentDocument) {
                docs.push(iframe.contentDocument);
              }
            } catch (error) {
              // Ignore cross-origin frames and continue probing other containers.
            }
          });

          for (const doc of docs) {
            const video = doc.querySelector('video');
            const audio = doc.querySelector('audio');
            if (video || audio) {
              return { video, audio };
            }
          }

          return null;
        };

        const waitForLessonMedia = (timeout = 30000) => new Promise((resolve) => {
          const startTime = Date.now();
          const timer = setInterval(() => {
            if ($.isPaused()) {
              return;
            }
            const media = getLessonMedia();
            if (media) {
              clearInterval(timer);
              resolve(media);
              return;
            }

            if (Date.now() - startTime >= timeout) {
              clearInterval(timer);
              resolve(null);
            }
          }, 500);
        });

        (async () => {
          const media = await waitForLessonMedia();
          if (!media) {
            $.alertMessage('课堂媒体 30 秒内未加载完成，跳过当前课程');
            play = true;
            advance(count + 1);
            history.go(-1);
            main();
            return;
          }

          const { video, audio } = media;
          if (video) {
            $.alertMessage('检测到课堂视频，开始播放');
            $.videoDetail(video);
            await waitForMediaEnd(video);
          }
          if (audio) {
            $.alertMessage('检测到课堂音频，开始播放');
            $.audioDetail(audio);
            await waitForMediaEnd(audio);
          }

          play = true;
          advance(count + 1);
          history.go(-1);
          main();
        })();
        return;
      }

      if (classInfo.includes('kejian') && play === true) {
        const tableData = course.parentNode?.parentNode?.parentNode?.__vue__?.tableData;
        const deadline = tableData?.deadline || tableData?.end;
        if (deadline && deadline < Date.now()) {
          $.alertMessage(`第 ${count + 1} 节课件已截止，跳过`);
          advance(count + 1);
          main();
          return;
        }

        $.alertMessage(`第 ${count + 1} 节进入课件区`);
        play = false;
        course.click();

        (async () => {
          await new Promise((resolve) => {
            setTimeout(() => {
              document.querySelector('.check')?.click();
              resolve();
            }, 3000);
          });

          const classType = document.querySelector('.el-card__header')?.innerText || '';
          const className = document.querySelector('.dialog-header')?.firstElementChild?.innerText || `第 ${count + 1} 节`;

          if (classType.includes('PPT')) {
            const allPPT = Array.from(document.querySelector('.swiper-wrapper')?.children || []);
            const pptTime = basicConf.pptTime || 3000;
            $.alertMessage(`开始播放：${className}`);
            for (let i = 0; i < allPPT.length; i++) {
              await new Promise((resolve) => {
                setTimeout(() => {
                  allPPT[i]?.click();
                  resolve();
                }, pptTime);
              });
            }

            const pptVideos = Array.from(document.querySelectorAll('.video-box') || []);
            for (let i = 0; i < pptVideos.length; i++) {
              if (pptVideos[i]?.innerText?.includes('已完成')) {
                continue;
              }
              pptVideos[i].click();
              await new Promise((resolve) => {
                setTimeout(() => {
                  $.ykt_speed();
                  document.querySelector('.xt_video_player_common_icon')?.click();
                  $.observePause();
                  resolve();
                }, 3000);
              });
              await new Promise((resolve) => {
                const timer = setInterval(() => {
                  if ($.isPaused()) {
                    return;
                  }
                  const allTime = document.querySelector('.xt_video_player_current_time_display')?.innerText || '';
                  const [nowTime, totalTime] = allTime.split(' / ');
                  if (nowTime && totalTime && nowTime === totalTime) {
                    clearInterval(timer);
                    $.observer?.disconnect();
                    resolve();
                  }
                }, 200);
              });
            }
            $.alertMessage(`${className} 播放完成`);
          } else {
            document.querySelector('.video-box')?.click();
            $.alertMessage(`开始播放课件视频：${className}`);
            await new Promise((resolve) => {
              setTimeout(() => {
                $.ykt_speed();
                document.querySelector('.xt_video_player_common_icon')?.click();
                resolve();
              }, 3000);
            });
            await new Promise((resolve) => {
              const timer = setInterval(() => {
                if ($.isPaused()) {
                  return;
                }
                const allTime = document.querySelector('.xt_video_player_current_time_display')?.innerText || '';
                const [nowTime, totalTime] = allTime.split(' / ');
                if (nowTime && totalTime && nowTime === totalTime) {
                  clearInterval(timer);
                  resolve();
                }
              }, 200);
            });
            $.alertMessage(`${className} 播放完成`);
          }

          play = true;
          advance(count + 1);
          history.back();
          main();
        })();
        return;
      }

      $.alertMessage(`第 ${count + 1} 节不是音视频课件，跳过`);
      advance(count + 1);
      main();
    });
  }

  async function autoSlide(currentCount) {
    const viewContainer = document.querySelector('.viewContainer');
    const tabPane = document.querySelector('.el-tab-pane');
    if (!viewContainer || !tabPane) {
      return;
    }
    const frequency = parseInt((currentCount + 1) / 20) + 1;
    for (let i = 0; i < frequency; i++) {
      await new Promise((resolve) => {
        setTimeout(() => {
          viewContainer.scrollTop = tabPane.scrollHeight;
          resolve();
        }, 1000);
      });
    }
  }

  main();
  return true;
}

function yuketang_pro_lms() {
  localStorage.setItem('n_type', true);
  $.alertMessage('Preparing the pro/lms lesson list...');

  if (!localStorage.getItem('pro_lms_classCount')) {
    localStorage.setItem('pro_lms_classCount', '1');
  }

  let classCount = Number(localStorage.getItem('pro_lms_classCount')) - 1;
  const leafDetail = Array.from(document.querySelectorAll('.leaf-detail'));

  if (!leafDetail.length) {
    $.alertMessage('No course list found, please refresh and try again.');
    return false;
  }

  while (classCount < leafDetail.length && !leafDetail[classCount]?.firstChild?.querySelector('i')?.className?.includes('shipin')) {
    classCount++;
    localStorage.setItem('pro_lms_classCount', String(classCount));
    $.alertMessage('Current lesson is not a video, skipping.');
  }

  if (classCount >= leafDetail.length) {
    localStorage.removeItem('pro_lms_classCount');
    $.alertMessage('No playable video lesson was found.');
    return false;
  }

  leafDetail[classCount].click();
  return true;
}

function yuketang_pro_lms_new() {
  $.preventScreenCheck();

  const getClassStatus = () => document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';

  function nextCount(classCount) {
    const nextBtn = document.querySelector('.btn-next');
    if (!nextBtn) {
      localStorage.removeItem('pro_lms_classCount');
      $.setRunning(false);
      $.alertMessage('课程播放完成');
      return;
    }

    localStorage.setItem('pro_lms_classCount', String(classCount));
    nextBtn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 9999, clientY: 9999 }));
    nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    localStorage.setItem('n_type', true);
    main();
  }

  $.alertMessage('已就绪，开始刷课，请尽量保持页面不动。');
  let classCount = Number(localStorage.getItem('pro_lms_classCount'));

  async function main() {
    $.alertMessage(`准备播放第 ${classCount} 节`);
    await new Promise((resolve) => {
      setTimeout(() => {
        const headerBar = document.querySelector('.header-bar')?.firstElementChild;
        if (!headerBar) {
          $.alertMessage('课程信息未加载完成，页面将重试');
          localStorage.setItem('n_type', true);
          location.reload();
          return;
        }

        const className = headerBar.innerText;
        const classType = headerBar.firstElementChild?.getAttribute('class') || '';
        const classStatus = getClassStatus();

        if (classType.includes('tuwen') && classStatus !== '已读') {
          $.alertMessage(`正在浏览：${className}`);
          setTimeout(resolve, 2000);
        } else if (classType.includes('taolun')) {
          $.alertMessage(`讨论区暂不支持自动回复：${className}`);
          setTimeout(resolve, 2000);
        } else if (classType.includes('shipin') && !isProgressDone(classStatus)) {
          $.alertMessage(`开始播放：${className}`);
          setTimeout(() => {
            const timer = setInterval(() => {
              if ($.isPaused()) {
                return;
              }
              const status = getClassStatus();
              if (isProgressDone(status)) {
                clearInterval(timer);
                $.observer?.disconnect();
                $.alertMessage(`${className} 播放完成`);
                resolve();
              }
            }, 200);

            const startTime = Date.now();
            const videoTimer = setInterval(() => {
              if ($.isPaused()) {
                return;
              }
              const video = document.querySelector('video');
              if (video) {
                setTimeout(() => {
                  $.ykt_speed();
                  $.claim();
                  $.observePause();
                  clearInterval(videoTimer);
                }, 2000);
              } else if (Date.now() - startTime > 20000) {
                clearInterval(videoTimer);
                localStorage.setItem('n_type', true);
                location.reload();
              }
            }, 5000);
          }, 2000);
        } else if (classType.includes('zuoye')) {
          $.alertMessage(`作业暂不支持自动作答：${className}`);
          setTimeout(resolve, 2000);
        } else if (classType.includes('kaoshi')) {
          $.alertMessage(`考试暂不支持自动答题：${className}`);
          setTimeout(resolve, 2000);
        } else if (classType.includes('ketang')) {
          $.alertMessage(`课堂作答暂不支持自动处理：${className}`);
          setTimeout(resolve, 2000);
        } else {
          $.alertMessage(`当前内容已处理：${className}`);
          setTimeout(resolve, 2000);
        }
      }, 2000);
    });

    $.alertMessage(`第 ${classCount} 节播放完成`);
    classCount++;
    nextCount(classCount);
  }

  main();
}

(function () {
  'use strict';
  // 防止在 iframe 内重复执行（Firefox 专用）
  if (window.top !== window.self) return;

  let initialized = false;
  const listenDom = setInterval(() => {
    if (document.body && !initialized) {
      initialized = true;
      clearInterval(listenDom);
      if (document.getElementById('ykt-helper-iframe')) return;
      addUserOperate();
      if (localStorage.getItem('n_type') === 'true') {
        $.panel.querySelector('#n_button').innerText = '刷课中~';
        $.setRunning(true);
        localStorage.setItem('n_type', false);
        yuketang_pro_lms_new();
      }
    }
  }, 100)
})();
