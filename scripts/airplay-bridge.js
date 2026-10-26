var fs = require('fs');
var http = require('http');
var cp = require('child_process');

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
var buf = '';
var prgrBase = 0;   // giây: vị trí bài hát tại lần prgr cuối
var prgrAt = 0;     // ms: thời điểm nhận prgr cuối (0 = chưa nhận trong phiên)

function restore() {
  try {
    if (fs.existsSync(ART)) { artBytes = fs.readFileSync(ART); }
  } catch (e) {}
  try {
    var s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (s && s.title) {
      st.title = s.title || '';
      st.artist = s.artist || '';
      st.album = s.album || '';
      st.progress = s.progress || null;
      st.volume = s.volume || null;
      st.lyrics = s.lyrics || null;
      st.lyricsSynced = s.lyricsSynced || null;
      st.hasArt = s.hasArt || false;
      st.artSeq = s.artSeq || 0;
      st.active = s.active || false;
    }
  } catch (e) {}
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
    persist();
  } else if (code === 'pbeg') {
    // Bắt đầu luồng phát mới -> vị trí về 0.
    st.active = true;
    prgrBase = 0; prgrAt = Date.now();
    persist();
  } else if (code === 'pcst') {
    // 'pcst' = SẮP gửi ảnh bìa (PICT) — KHÔNG phải "bắt đầu bài hát".
    persist();
  } else if (code === 'pend') {
    st.active = false;
    persist();
  } else if (code === 'pfls') {
    // Audio flushed on seek/pause; tạm dừng nội suy mốc thời gian, không tắt session
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
  if (buf.indexOf('</item>') === -1) {
    if (buf.length > 4000000) { buf = ''; }
    return;
  }
  var re = /<item>([\s\S]*?)<\/item>/g;
  var m, consumed = 0;
  while ((m = re.exec(buf)) !== null) {
    processItemBody(m[1]);
    consumed = re.lastIndex;
  }
  if (consumed > 0) { buf = buf.substring(consumed); }
  if (buf.length > 4000000) { buf = ''; }
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
    pipeStream.on('data', function (chunk) { buf += chunk; parseBuf(); });
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

var server = http.createServer(function (req, res) {
  try { route(req, res); }
  catch (e) { try { res.writeHead(500, cors()); res.end('err'); } catch (x) {} }
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
  } else {
    res.writeHead(200, cors());
    res.end('airplay-bridge ok');
  }
}

process.on('uncaughtException', function (e) {
  try { fs.appendFileSync('/tmp/airplay-bridge.err', (new Date()) + ' ' + e + '\n'); } catch (x) {}
});

restore();
persist();
openPipe();
server.listen(PORT, '127.0.0.1');
try { fs.writeFileSync('/tmp/airplay-bridge.pid', String(process.pid)); } catch (e) {}
