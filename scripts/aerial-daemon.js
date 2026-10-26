// aerial-daemon.js — one Node process doing the whole job on webOS 4.5 (Node 0.12, armv7l 32-bit).
//
// Merged from homewatch.js + airplay-bridge.js to save a node runtime (~29 MB) on a
// RAM-tight TV, and to make the AirPlay bridge survive reboot (it now has an init.d entry).
//
//  A) HOME WATCH  — read-only poll of /dev/input/event* for HOME (code 773):
//       short press  -> re-foreground our launcher (com.apple.aerial.tvos).
//       hold >= 5s   -> leave the stock home in front. We do not launch it: the key itself
//                       already opens it, so on a hold we only stop re-foregrounding.
//     Manual hook: echo an appId into /tmp/aerial-homewatch-cmd to launch it; echo "fg" to
//     dump the foreground app; echo "reap" to close com.webos.app.fullhome.
//     NOTE: com.webos.app.fullhome is a SAM-managed home window (appinfo defaultWindowType
//     "home"). closeByAppId reports success but does NOT kill it, and SAM (/usr/sbin/sam)
//     respawns the native process (same pid) after any kill — so we deliberately do NOT
//     churn on it. It idles ~37 MB background at 0% CPU; not worth fighting.
//  B) AIRPLAY BRIDGE — HTTP on 127.0.0.1:8899 serving /state and /art, fed by the
//     shairport-sync metadata FIFO /tmp/shairport-sync-metadata.
//
// Privileged luna (fg probe / close) only works when this runs from the boot context
// (started by init.d), NOT over an SSH session.
var fs = require('fs');
var cp = require('child_process');
var http = require('http');
var https = require('https');

/* ============================================================================
 * A) HOME WATCH
 * ========================================================================== */
var APP = 'com.apple.aerial.tvos';
var STOCK_HOME = 'com.webos.app.home'; // the stock Home launcher webOS spawns
var HOME_CODE = 773;
var EV_KEY = 1, EV_SIZE = 16, O_NONBLOCK = 2048;
var LUNA = '/usr/bin/luna-send';
var LOG = '/tmp/aerial-homewatch.log';
var CMD = '/tmp/aerial-homewatch-cmd';
var LONG_MS = 3000;

function log(m) { try { fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + m + '\n'); } catch (e) {} }

function luna(id, reason) {
  cp.execFile(LUNA, ['-a', 'webosbrew', '-f', '-n', '1',
    'luna://com.webos.applicationManager/launch', '{"id":"' + id + '"}'],
    function (err, so, se) {
      log('launch ' + id + ' (' + reason + ') err=' + (err ? err.message : '-') +
          ' out=' + String(so).replace(/\s+$/, '') + ' ' + String(se).replace(/\s+$/, ''));
    });
}

// Gracefully close an app so SAM does NOT treat it as a crash and relaunch it.
// On webOS TV the plain `close` method is deprecated ("Don't use this API in TV"); try the
// by-appId methods first and fall back. Stop early on "not running" so we don't fork 3 luñas
// every tick when there is nothing to close.
var CLOSE_TARGETS = [
  ['luna://com.webos.service.applicationmanager/closeByAppId', 'closeByAppId/svc'],
  ['luna://com.webos.applicationManager/closeByAppId', 'closeByAppId/tv'],
  ['luna://com.webos.service.applicationmanager/close', 'close/svc'],
  ['luna://com.webos.applicationManager/close', 'close/tv']
];
function lunaClose(id, reason) { tryClose(id, reason, 0); }
function tryClose(id, reason, i) {
  if (i >= CLOSE_TARGETS.length) { log('close ' + id + ' (' + reason + ') FAILED all methods'); return; }
  var t = CLOSE_TARGETS[i];
  cp.execFile(LUNA, ['-a', 'webosbrew', '-f', '-n', '1', t[0], '{"id":"' + id + '"}'],
    function (err, so, se) {
      var ok = false, txt = '';
      try { var o = JSON.parse(so); ok = o.returnValue === true; txt = o.errorText || ''; } catch (e) {}
      log('close ' + id + ' via ' + t[1] + ' (' + reason + ') err=' + (err ? err.message : '-') +
          ' ok=' + ok + ' out=' + String(so).replace(/\s+$/, '') + ' ' + String(se).replace(/\s+$/, ''));
      if (ok) { return; }
      if (/not running|no app|empty/i.test(txt)) { return; } // nothing there; don't spam other methods
      tryClose(id, reason, i + 1);
    });
}

// Read which app currently owns the foreground (privileged-only; works from the boot context).
function fg(cb) {
  cp.execFile(LUNA, ['-a', 'webosbrew', '-n', '1',
    'luna://com.webos.applicationManager/getForegroundAppInfo', '{}'],
    function (err, so, se) {
      var id = '';
      try {
        var o = JSON.parse(so);
        id = o.appId || (o.foregroundAppInfo && o.foregroundAppInfo.appId) || '';
      } catch (e) {}
      cb(id, String(so).replace(/\s+$/, '') + ' ' + String(se).replace(/\s+$/, ''));
    });
}

// Re-foreground our app: the stock Home opens on the key and (during its CRIU restore) silently
// ignores launches for a few seconds, so retry every 1s until one lands. Once getForegroundAppInfo
// reports our app on top we stop immediately (fast + no spam); a hard cap of 12 protects us if the
// probe is ever unavailable. The ladder is CANCELLABLE: a new press (or a long-press firing) stops
// it, so a stale ladder can never yank us back out of the stock Home after a later long-press.
var bringBusy = false;
function stopBring() { bringBusy = false; }
function bringBack() {
  if (bringBusy) return;
  bringBusy = true;
  luna(APP, 'bring');
  setTimeout(function () { bringBusy = false; }, 2000);
}

// Boot: keep (re)launching our app until it actually owns the foreground. At cold boot webOS
// shows HDMI/Home first and swallows early launches, so a 3-shot autostart is not enough. We
// start almost immediately and probe every 1s so the launch fires the instant webOS can honor it.
var BOOT_UNTIL = Date.now() + 150000;
function bootBring() {
  var iv = null;
  function tick() {
    if (Date.now() > BOOT_UNTIL) { log('boot bring: deadline'); if (iv) clearInterval(iv); return; }
    fg(function (id) {
      if (id === APP) {
        log('boot bring: launcher is foreground');
        if (iv) clearInterval(iv);
        return;
      }
      log('boot bring: fg=' + (id || '?') + ' -> launch ' + APP);
      luna(APP, 'boot');
    });
  }
  tick();                          // fire the very first probe/launch immediately
  iv = setInterval(tick, 1000);
}

// No periodic fullhome reaper: it is a SAM-managed home window that SAM always respawns, so
// closing it every tick only churns a luna fork for no gain. See the header note.

try { fs.writeFileSync('/tmp/aerial-homewatch.pid', String(process.pid)); } catch (e) {}
log('aerial-daemon start pid=' + process.pid);

var names = {};
try {
  fs.readFileSync('/proc/bus/input/devices', 'utf8').split(/\n\n+/).forEach(function (blk) {
    var m = blk.match(/N: Name="([^"]+)"[\s\S]*?H: Handlers=([^\n]*)/);
    if (m) { (m[2].match(/event\d+/g) || []).forEach(function (e) { names[e] = m[1]; }); }
  });
} catch (e) {}

var fds = {};
fs.readdirSync('/dev/input').filter(function (f) { return /^event\d+$/.test(f); })
  .forEach(function (f) { try { fds[f] = fs.openSync('/dev/input/' + f, 0 | O_NONBLOCK); } catch (e) {} });
log('watching ' + Object.keys(fds).length + ' devices');

var keyBuf = new Buffer(EV_SIZE * 64);
var longTimer = null;
var longFired = false;
var stockHomeAllowed = false;
var stockHomeTimer = null;

function allowStockHome(ms) {
  stockHomeAllowed = true;
  if (stockHomeTimer) clearTimeout(stockHomeTimer);
  stockHomeTimer = setTimeout(function () {
    stockHomeAllowed = false;
  }, ms || 60000);
}

function watchForeground() {
  log('starting foreground subscription watcher...');
  var sub = cp.spawn(LUNA, ['-a', 'webosbrew', '-i',
    'luna://com.webos.applicationManager/getForegroundAppInfo', '{"subscribe":true}']);

  var buf = '';
  sub.stdout.on('data', function (data) {
    buf += data.toString();
    var lines = buf.split('\n');
    buf = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      try {
        var o = JSON.parse(line);
        var id = o.appId || (o.foregroundAppInfo && o.foregroundAppInfo.appId) || '';
        if (id) {
          log('fg sub event -> ' + id);
          if (id === 'com.webos.app.home' || id === 'com.webos.app.fullhome') {
            if (!stockHomeAllowed) {
              log('blocked STOCK_HOME in foreground -> returning to ' + APP);
              bringBack();
            } else {
              log('STOCK_HOME allowed by hotkey');
            }
          } else if (id === 'airplay' || id === 'com.webos.app.screensaver') {
            log('blocked rogue overlay (' + id + ') -> closing and returning to ' + APP);
            lunaClose(id, 'blocked');
            bringBack();
          } else if (id === APP) {
            stockHomeAllowed = false;
          }
        }
      } catch (e) {}
    }
  });

  sub.on('exit', function (code) {
    log('fg sub exited code=' + code + ', restarting in 2s');
    setTimeout(watchForeground, 2000);
  });

  sub.on('error', function (err) {
    log('fg sub error: ' + (err ? err.message : '-'));
  });
}

function onPress() {
  stopBring();
  longFired = false;
  if (longTimer) { clearTimeout(longTimer); longTimer = null; }
  longTimer = setTimeout(function () {
    longFired = true;
    stopBring();
    log('HOME hold >= ' + (LONG_MS / 1000) + 's -> launch stock home');
    allowStockHome(60000);
    luna(STOCK_HOME, 'cold-start-hotkey');
  }, LONG_MS);
}
function onRelease() {
  if (longTimer) { clearTimeout(longTimer); longTimer = null; }
  if (!longFired) {
    log('HOME short press -> bring back ' + APP);
    stockHomeAllowed = false;
    bringBack();
  }
}

watchForeground();

setInterval(function () {
  for (var f in fds) {
    var n = 0;
    try { n = fs.readSync(fds[f], keyBuf, 0, keyBuf.length, null); } catch (e) { continue; }
    for (var off = 0; off + EV_SIZE <= n; off += EV_SIZE) {
      var type = keyBuf.readUInt16LE(off + 8);
      var code = keyBuf.readUInt16LE(off + 10);
      var val = keyBuf.readInt32LE(off + 12);
      if (type === EV_KEY) {
        if (code === HOME_CODE) {
          log('HOME773 dev=' + f + ' val=' + val);
          if (val === 1) onPress();
          else if (val === 0) onRelease();
        } else if (code === 412 && val === 1) {
          log('BLUE_KEY_412 pressed -> show voice search helper toast');
          showToast('🎙️ Giọng nói: Mở http://192.168.1.6:8899/voice trên điện thoại để nói');
        } else {
          log('KEY dev=' + f + ' code=' + code + ' val=' + val);
        }
      }
    }
  }
}, 16);

// Manual hook for testing: echo an appId into CMD to launch it; echo "fg" to dump foreground;
// echo "reap" to close the stock Home.
setInterval(function () {
  try {
    if (fs.existsSync(CMD)) {
      var id = ('' + fs.readFileSync(CMD)).trim();
      fs.unlinkSync(CMD);
      if (id === 'fg') {
        fg(function (a, raw) { log('cmd fg -> appId=' + (a || '(none)') + ' raw=' + raw); });
      } else if (id === 'reap') {
        log('cmd -> reap ' + STOCK_HOME);
        lunaClose(STOCK_HOME, 'cmd');
      } else if (id.indexOf('close ') === 0) {
        log('cmd -> close ' + id.substring(6));
        lunaClose(id.substring(6).replace(/^\s+|\s+$/g, ''), 'cmd');
      } else if (id) { log('cmd -> launch ' + id); luna(id, 'cmd'); }
    }
  } catch (e) {}
}, 250);

// bootBring() called cp.execFile() repeatedly on Node 0.12, causing glibc futex fork deadlock
// Autostart is already handled cleanly by /var/lib/webosbrew/init.d/20-aerial-launcher
// setTimeout(function () { log('boot bring: start'); bootBring(); }, 1500);

/* ============================================================================
 * B) AIRPLAY BRIDGE
 * ========================================================================== */
var PIPE = '/tmp/shairport-sync-metadata';
var STATE = '/tmp/nowplaying.json';
var ART = '/tmp/airplay-art.jpg';
var PORT = 8899;
var CURL = '/usr/bin/curl';

var st = {
  active: false,
  title: '',
  artist: '',
  album: '',
  volume: null,
  progress: null,
  hasArt: false,
  artSeq: 0,
  lyrics: null,
  lyricsSynced: null,
  updated: 0
};

var artBytes = null;
var lastLyricKey = '';
var metaBuf = '';
var prgrBase = 0;   // giây: vị trí bài hát tại lần prgr cuối
var prgrAt = 0;     // ms: thời điểm nhận prgr cuối (0 = chưa nhận trong phiên)

function resetNowPlaying() {
  st.active = false;
  st.title = '';
  st.artist = '';
  st.album = '';
  st.progress = null;
  st.volume = null;
  st.lyrics = null;
  st.lyricsSynced = null;
  st.hasArt = false;
  st.artSeq = st.artSeq + 1;
  artBytes = null;
  prgrBase = 0;
  prgrAt = 0;
  lastLyricKey = '';
  persist();
}

function restore() {
  try {
    if (fs.existsSync(ART)) { artBytes = fs.readFileSync(ART); }
  } catch (e) {}
  // Không khôi phục active=true khi khởi động lại daemon: luôn bắt đầu sạch!
  resetNowPlaying();
}

function persist() {
  st.updated = Date.now();
  try { fs.writeFileSync(STATE, JSON.stringify(st)); } catch (e) {}
}

function decodeData(b64) {
  try { return new Buffer(b64, 'base64').toString('utf8'); } catch (e) { return ''; }
}

function hexToAscii(h) {
  try { return new Buffer(h, 'hex').toString('ascii'); } catch (e) { return ''; }
}

function sanitize(s) {
  if (!s) { return ''; }
  var i = s.indexOf('\u2022');
  if (i > 0) { s = s.substring(0, i); }
  i = s.indexOf('\u00b7');
  if (i > 0) { s = s.substring(0, i); }
  s = s.replace(/^\s+/, '').replace(/\s+$/, '');
  s = s.replace(/\s*\((feat|ft|with)[^)]*\)/i, '');
  return s.replace(/\s+$/, '');
}

function setArt(b64) {
  try {
    var b = new Buffer(b64, 'base64');
    if (b && b.length > 0) {
      artBytes = b;
      fs.writeFileSync(ART, b);
      st.hasArt = true;
      st.artSeq = st.artSeq + 1;
    }
  } catch (e) {
    st.hasArt = false;
  }
}

function handleItem(typeHex, codeHex, dataB64) {
  var code = hexToAscii(codeHex);
  if (code === 'minm') {
    var newTitle = decodeData(dataB64);
    if (newTitle && newTitle !== st.title) {
      st.title = newTitle;
      st.active = true;
      st.hasArt = false;
      artBytes = null;
      st.artSeq = st.artSeq + 1;
      persist();
    }
  } else if (code === 'asar') {
    st.artist = decodeData(dataB64);
    persist();
  } else if (code === 'asal') {
    st.album = decodeData(dataB64);
    persist();
  } else if (code === 'pvol') {
    st.volume = decodeData(dataB64);
    persist();
  } else if (code === 'prgr') {
    // shairport gửi prgr dạng text "start/current/end" (đơn vị 44100 mẫu/giây),
    // và CHỈ gửi vài lần (đầu bài / seek / pause) — không cập nhật liên tục.
    // Vì vậy neo vị trí tại đây rồi tự nội suy theo đồng hồ Node.
    var raw = decodeData(dataB64);
    st.progress = raw;
    var mp = String(raw).split('/');
    if (mp.length >= 2) {
      var s0 = parseFloat(mp[0]), n0 = parseFloat(mp[1]);
      if (isFinite(s0) && isFinite(n0)) { prgrBase = Math.max(0, (n0 - s0) / 44100); prgrAt = Date.now(); }
    }
    st.active = true;
    persist();
  } else if (code === 'pbeg' || code === 'prsm') {
    // Bắt đầu hoặc tiếp tục luồng phát
    st.active = true;
    if (code === 'pbeg') { prgrBase = 0; }
    prgrAt = Date.now();
    persist();
  } else if (code === 'pcst') {
    // 'pcst' = SẮP gửi ảnh bìa (PICT) — KHÔNG phải "bắt đầu bài hát".
    persist();
  } else if (code === 'pend' || code === 'aend') {
    log('AirPlay session end (' + code + ') -> resetting NowPlaying');
    resetNowPlaying();
  } else if (code === 'pfls') {
    // Audio flushed on seek/pause; tạm dừng nội suy mốc thời gian
    prgrAt = 0;
    persist();
  } else if (code === 'PICT') {
    setArt(dataB64);
    persist();
  }
}

function processItemBody(body) {
  var t = /<type>([0-9a-fA-F]+)<\/type>/.exec(body);
  var c = /<code>([0-9a-fA-F]+)<\/code>/.exec(body);
  var d = /<data encoding="base64">([\s\S]*?)<\/data>/.exec(body);
  if (!c) { return; }
  var typeHex = t ? t[1] : '';
  var codeHex = c[1];
  var dataB64 = d ? d[1].replace(/\s+/g, '') : '';
  handleItem(typeHex, codeHex, dataB64);
}

function parseBuf() {
  if (metaBuf.indexOf('</item>') === -1) {
    if (metaBuf.length > 4000000) { metaBuf = ''; }
    return;
  }
  var re = /<item>([\s\S]*?)<\/item>/g;
  var m, consumed = 0;
  while ((m = re.exec(metaBuf)) !== null) {
    processItemBody(m[1]);
    consumed = re.lastIndex;
  }
  if (consumed > 0) { metaBuf = metaBuf.substring(consumed); }
  if (metaBuf.length > 4000000) { metaBuf = ''; }
}

var pipeStream = null;
var reopenTimer = null;
function scheduleReopen(delay) {
  if (reopenTimer) return;
  reopenTimer = setTimeout(function () {
    reopenTimer = null;
    openPipe();
  }, delay || 500);
}

function openPipe() {
  if (pipeStream) {
    try { pipeStream.destroy(); } catch (e) {}
    pipeStream = null;
  }
  try {
    pipeStream = fs.createReadStream(PIPE, { encoding: 'utf8' });
    pipeStream.on('data', function (chunk) { metaBuf += chunk; parseBuf(); });
    pipeStream.on('error', function () { scheduleReopen(1000); });
    pipeStream.on('end', function () { scheduleReopen(300); });
    pipeStream.on('close', function () { scheduleReopen(300); });
  } catch (e) {
    scheduleReopen(1000);
  }
}

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
}

/* ============================================================================
 * C) GROQ WHISPER TURBO & YOUTUBE DEEPLINK VOICE SEARCH
 * ========================================================================== */
var GROQ_KEY_FILE = '/var/lib/webosbrew/groq_api_key';
var GROQ_API_KEY = '';
try { GROQ_API_KEY = fs.readFileSync(GROQ_KEY_FILE, 'utf8').trim(); } catch (e) {}
var YOUTUBE_APP = 'youtube.leanback.v4';

function showToast(msg) {
  try {
    fs.writeFileSync('/tmp/voice_toast_msg', String(msg));
  } catch (e) {}
}

function launchYouTubeSearch(query) {
  log('launchYouTubeSearch: ' + query);
  try {
    fs.writeFileSync('/tmp/youtube_voice_query', String(query));
  } catch (e) {
    log('Failed to write voice query: ' + e.message);
  }
}

function transcribeWithGroq(audioBuffer, mimeType, callback) {
  var boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  var filename = 'voice.webm';
  if (mimeType && (mimeType.indexOf('mp4') !== -1 || mimeType.indexOf('m4a') !== -1)) filename = 'voice.m4a';
  else if (mimeType && mimeType.indexOf('wav') !== -1) filename = 'voice.wav';

  var parts = [];
  parts.push('--' + boundary + '\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n');
  parts.push('--' + boundary + '\r\nContent-Disposition: form-data; name="language"\r\n\r\nvi\r\n');
  parts.push('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + filename + '"\r\nContent-Type: ' + (mimeType || 'audio/webm') + '\r\n\r\n');

  var headerBuf = new Buffer(parts.join(''));
  var footerBuf = new Buffer('\r\n--' + boundary + '--\r\n');
  var totalLen = headerBuf.length + audioBuffer.length + footerBuf.length;

  var req = https.request({
    hostname: 'api.groq.com',
    port: 443,
    path: '/openai/v1/audio/transcriptions',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + GROQ_API_KEY,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': totalLen,
      'User-Agent': 'curl/7.68.0'
    }
  }, function(res) {
    var data = '';
    res.on('data', function(c) { data += c; });
    res.on('end', function() {
      try {
        var parsed = JSON.parse(data);
        if (parsed.text) {
          callback(null, parsed.text.trim());
        } else {
          callback(new Error(parsed.error ? parsed.error.message : data));
        }
      } catch (e) {
        callback(e);
      }
    });
  });

  req.on('error', function(e) {
    callback(e);
  });

  req.write(headerBuf);
  req.write(audioBuffer);
  req.write(footerBuf);
  req.end();
}

var VOICE_HTML = '<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">' +
'<title>Sonoma TV Voice Search</title>' +
'<style>' +
'* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }' +
'body { margin: 0; padding: 0; background: #0b0c10; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; text-align: center; }' +
'.card { background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 28px; padding: 40px 24px; width: 90%; max-width: 380px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }' +
'.title { font-size: 22px; font-weight: 700; margin-bottom: 6px; letter-spacing: -0.5px; }' +
'.subtitle { font-size: 13px; color: rgba(255,255,255,0.5); margin-bottom: 36px; }' +
'.mic-btn { width: 110px; height: 110px; border-radius: 50%; background: linear-gradient(135deg, #0071e3, #00c6ff); border: none; outline: none; cursor: pointer; display: flex; align-items: center; justify-content: center; margin: 0 auto 30px; box-shadow: 0 10px 25px rgba(0, 113, 227, 0.4); transition: transform 0.15s, box-shadow 0.15s; }' +
'.mic-btn:active, .mic-btn.recording { transform: scale(0.92); background: linear-gradient(135deg, #ff3b30, #ff9500); box-shadow: 0 0 35px rgba(255, 59, 48, 0.7); animation: pulse 1.2s infinite alternate; }' +
'@keyframes pulse { 0% { transform: scale(0.92); box-shadow: 0 0 20px rgba(255, 59, 48, 0.5); } 100% { transform: scale(1.02); box-shadow: 0 0 40px rgba(255, 59, 48, 0.9); } }' +
'.mic-icon { width: 44px; height: 44px; fill: #fff; }' +
'.status { font-size: 15px; font-weight: 500; min-height: 24px; color: #a1a1a6; }' +
'.status.active { color: #2997ff; }' +
'.status.error { color: #ff453a; }' +
'.status.success { color: #30d158; font-weight: 600; }' +
'.result { margin-top: 15px; font-size: 18px; font-weight: 600; color: #fff; min-height: 26px; }' +
'.badge { margin-top: 24px; display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: rgba(255,255,255,0.06); border-radius: 12px; font-size: 11px; color: rgba(255,255,255,0.4); }' +
'</style></head><body>' +
'<div class="card">' +
'  <div class="title">Sonoma TV</div>' +
'  <div class="subtitle">Tìm kiếm YouTube bằng giọng nói</div>' +
'  <button class="mic-btn" id="btn">' +
'    <svg class="mic-icon" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>' +
'  </button>' +
'  <input type="file" id="fileMic" accept="audio/*" capture="microphone" style="display:none">' +
'  <div class="status" id="st">Chạm vào nút để nói</div>' +
'  <div class="result" id="res"></div>' +
'  <div class="badge"><span>⚡ Powered by Groq Whisper Turbo</span></div>' +
'</div>' +
'<script>' +
'var btn = document.getElementById("btn");' +
'var st = document.getElementById("st");' +
'var res = document.getElementById("res");' +
'var fileMic = document.getElementById("fileMic");' +
'var recorder = null; var stream = null; var chunks = []; var isRecording = false;' +
'async function startRec() {' +
'  chunks = [];' +
'  try {' +
'    if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio: true });' +
'    var mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : (MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "");' +
'    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);' +
'    recorder.ondataavailable = function(e) { if (e.data.size > 0) chunks.push(e.data); };' +
'    recorder.onstop = uploadAudio;' +
'    recorder.start();' +
'    isRecording = true;' +
'    btn.classList.add("recording");' +
'    st.className = "status active";' +
'    st.textContent = "Đang nghe... Chạm lại để tìm kiếm";' +
'    res.textContent = "";' +
'  } catch(err) { fileMic.click(); }' +
'}' +
'function stopRec() {' +
'  if (recorder && isRecording) {' +
'    recorder.stop();' +
'    isRecording = false;' +
'    btn.classList.remove("recording");' +
'    st.className = "status";' +
'    st.textContent = "Đang gửi tới Groq...";' +
'  }' +
'}' +
'btn.addEventListener("click", function() {' +
'  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { fileMic.click(); return; }' +
'  if (isRecording) stopRec(); else startRec();' +
'});' +
'fileMic.addEventListener("change", function(e) {' +
'  if (e.target.files && e.target.files[0]) {' +
'    st.className = "status"; st.textContent = "Đang gửi tới Groq...";' +
'    var f = e.target.files[0]; sendBlob(f, f.type || "audio/mp4");' +
'  }' +
'});' +
'function uploadAudio() {' +
'  var mime = (recorder && recorder.mimeType) || "audio/webm";' +
'  var blob = new Blob(chunks, { type: mime });' +
'  sendBlob(blob, mime);' +
'}' +
'async function sendBlob(blob, mime) {' +
'  try {' +
'    var r = await fetch("/api/voice", { method: "POST", headers: { "Content-Type": mime }, body: blob });' +
'    var d = await r.json();' +
'    if (d.success && d.text) {' +
'      st.className = "status success";' +
'      st.textContent = "✓ Đã mở YouTube trên TV:";' +
'      res.textContent = d.text;' +
'    } else {' +
'      st.className = "status error";' +
'      st.textContent = "Lỗi: " + (d.error || "Không nhận dạng được");' +
'    }' +
'  } catch(e) { st.className = "status error"; st.textContent = "Lỗi kết nối: " + e.message; }' +
'}' +
'</script></body></html>';

var server = http.createServer(function (req, res) {
  if (req.url && req.url.indexOf('/state') !== 0) {
    log('HTTP ' + req.method + ' ' + req.url);
  }
  try { route(req, res); }
  catch (e) {
    log('HTTP error: ' + (e ? e.message : e));
    try { res.writeHead(500, cors()); res.end('err'); } catch (x) {}
  }
});

function route(req, res) {
  var u = req.url || '/';
  if (u.indexOf('/art') === 0) {
    if (!artBytes) { res.writeHead(404, cors()); res.end('no art'); return; }
    var h = cors();
    h['Content-Type'] = 'image/jpeg';
    res.writeHead(200, h);
    res.end(artBytes);
  } else if (u.indexOf('/state') === 0) {
    // `position` = vị trí bài hát (giây) nội suy theo đồng hồ Node; null nếu
    // chưa nhận prgr trong phiên (launcher sẽ tự nội suy từ progress thô).
    st.position = prgrAt ? (prgrBase + (st.active ? (Date.now() - prgrAt) / 1000 : 0)) : null;
    var h2 = cors();
    h2['Content-Type'] = 'application/json';
    res.writeHead(200, h2);
    res.end(JSON.stringify(st));
  } else if (u.indexOf('/refetch') === 0) {
    // Lyrics được launcher (Chromium) tự fetch qua LRCLIB để tránh fork curl
    // trên CPU yếu (fork chậm vì áp lực RAM/swap) làm nghẽn event loop.
    res.writeHead(200, cors());
    res.end('client-side');
  } else if (u.indexOf('/voice') === 0 && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(VOICE_HTML);
  } else if (u.indexOf('/api/voice') === 0 && req.method === 'POST') {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      var audioBuf = Buffer.concat(chunks);
      var ctype = req.headers['content-type'] || 'audio/webm';
      log('Received voice upload: ' + audioBuf.length + ' bytes (' + ctype + ')');
      if (audioBuf.length < 100) {
        res.writeHead(400, cors());
        res.end(JSON.stringify({ error: 'Audio too short' }));
        return;
      }
      transcribeWithGroq(audioBuf, ctype, function (err, text) {
        if (err || !text) {
          log('Groq error: ' + (err ? err.message : 'empty text'));
          res.writeHead(500, cors());
          res.end(JSON.stringify({ error: err ? err.message : 'Transcription failed' }));
          return;
        }
        log('Groq transcribed: "' + text + '" -> launching YouTube');
        launchYouTubeSearch(text);
        showToast('🎙️ Tìm YouTube: "' + text + '"');
        res.writeHead(200, cors());
        res.end(JSON.stringify({ success: true, text: text }));
      });
    });
  } else {
    res.writeHead(200, cors());
    res.end('airplay-bridge ok');
  }
}

process.on('uncaughtException', function (e) {
  try { fs.appendFileSync('/tmp/airplay-bridge.err', (new Date()) + ' ' + e + '\n'); } catch (x) {}
});

/* ============================================================================
 * C) POWER LIFECYCLE & AIRPLAY CONNECTION WATCHDOG
 * ========================================================================== */

var isSuspended = false;

function onSuspend(pwrState) {
  if (isSuspended) return;
  isSuspended = true;
  log('TV entering sleep (' + pwrState + ') -> terminating AirPlay & resetting state');

  // 1. Lockfile prevents 22-airplay daemon babysitter from restarting shairport-sync in sleep
  try { fs.writeFileSync('/tmp/tv_suspended', '1'); } catch (e) {}

  // 2. Wipe NowPlaying metadata state immediately
  resetNowPlaying();

  // 3. Close metadata FIFO read stream
  if (pipeStream) {
    try { pipeStream.destroy(); } catch (e) {}
    pipeStream = null;
  }

  // 4. Forcefully terminate shairport-sync process so TCP port 5001 is immediately closed (FIN/RST).
  // iPhone will instantly recognize that Sonoma TV is off and disconnect cleanly!
  cp.exec('killall -9 shairport-sync ld-linux.so.3 2>/dev/null', function () {});
}

function onResume(pwrState) {
  if (!isSuspended) return;
  isSuspended = false;
  log('TV woke up (' + pwrState + ') -> starting clean AirPlay receiver & resetting state');

  // 1. Remove lockfile
  try { if (fs.existsSync('/tmp/tv_suspended')) fs.unlinkSync('/tmp/tv_suspended'); } catch (e) {}

  // 2. Ensure state is completely clean
  resetNowPlaying();

  // 3. Start shairport-sync
  cp.exec('sh /var/lib/webosbrew/start-airplay.sh >/dev/null 2>&1 &', function () {});

  // 4. Reopen metadata pipe
  scheduleReopen(1200);
}

function watchPower() {
  log('starting power wake/sleep subscription watcher...');
  var pwr = cp.spawn(LUNA, ['-a', 'webosbrew', '-i',
    'luna://com.webos.service.tvpower/power/getPowerState', '{"subscribe":true}']);

  var pbuf = '';
  pwr.stdout.on('data', function (data) {
    pbuf += data.toString();
    var lines = pbuf.split('\n');
    pbuf = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      try {
        var o = JSON.parse(line);
        var state = o.state || '';
        log('power state event -> ' + state);
        if (state === 'Active' || state === 'active') {
          onResume(state);
        } else if (state === 'Suspend' || state === 'Active Standby' || state === 'standby' ||
                   state === 'Suspend Prepare' || state === 'Prepare Suspend') {
          onSuspend(state);
        }
      } catch (e) {}
    }
  });

  pwr.on('exit', function (code) {
    log('power sub exited code=' + code + ', restarting in 2s');
    setTimeout(watchPower, 2000);
  });

  pwr.on('error', function (err) {
    log('power sub error: ' + (err ? err.message : '-'));
  });
}

var noConnCount = 0;

function checkAirPlayConnection() {
  if (isSuspended) return;

  // Nếu st.active = true, xác nhận có kết nối TCP thực tế tới cổng 5001
  if (st.active) {
    var hasEst = false;
    try {
      var tcp = '';
      try { tcp += fs.readFileSync('/proc/net/tcp', 'utf8'); } catch (e) {}
      try { tcp += fs.readFileSync('/proc/net/tcp6', 'utf8'); } catch (e) {}

      var lines = tcp.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        var parts = line.split(/\s+/);
        if (parts.length >= 4) {
          var local = parts[1];
          var connState = parts[3];
          // 1389 là port 5001 hex, 01 là TCP_ESTABLISHED
          if (local.indexOf(':1389') !== -1 && connState === '01') {
            hasEst = true;
            break;
          }
        }
      }
    } catch (e) {}

    if (!hasEst) {
      noConnCount++;
      // Chỉ khi mất kết nối liên tục 2 lần (4 giây) mới reset để tránh jitter mạng ngắn hạn
      if (noConnCount >= 2) {
        log('Watchdog: No established connection on 5001 for 4s -> resetting AirPlay state');
        resetNowPlaying();
        noConnCount = 0;
      }
    } else {
      noConnCount = 0;
    }
  } else {
    noConnCount = 0;
  }
}

restore();
persist();
openPipe();
watchPower();
setInterval(checkAirPlayConnection, 2000);
server.listen(PORT, '0.0.0.0', function () {
  log('AirPlay bridge & Voice server listening on 0.0.0.0:' + PORT);
});
try { fs.writeFileSync('/tmp/airplay-bridge.pid', String(process.pid)); } catch (e) {}
