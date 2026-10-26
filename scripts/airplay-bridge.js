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
    artBytes = b;
    fs.writeFileSync(ART, b);
    st.hasArt = true;
    st.artSeq = st.artSeq + 1;
  } catch (e) {
    st.hasArt = false;
  }
}

function curlJson(url, cb, attempt) {
  attempt = attempt || 0;
  var cmd = CURL + ' -s --max-time 8 -A "airplay-bridge/1.0" -H "Lrclib-Client: airplay-bridge/1.0" "' + url + '"';
  cp.exec(cmd, function (err, stdout) {
    var arr = null, valid = false;
    if (!err && stdout) {
      try { arr = JSON.parse(stdout); valid = true; } catch (e) { valid = false; }
    }
    // JSON hợp lệ (kể cả mảng rỗng `[]`) = câu trả lời cuối cùng, KHÔNG retry.
    // Chỉ retry khi curl lỗi/không trả JSON (vd 503 ServerOverloaded).
    if (valid) { cb(arr); return; }
    if (attempt < 4) { setTimeout(function () { curlJson(url, cb, attempt + 1); }, 2000); }
    else { cb(null); }
  });
}

function pickLyrics(arr, key) {
  if (lastLyricKey !== key) { return; }
  var best = null, i;
  for (i = 0; i < arr.length; i++) { if (arr[i].syncedLyrics) { best = arr[i]; break; } }
  if (!best) { for (i = 0; i < arr.length; i++) { if (arr[i].plainLyrics) { best = arr[i]; break; } } }
  if (!best) { best = arr[0]; }
  st.lyrics = best.plainLyrics || null;
  st.lyricsSynced = best.syncedLyrics || null;
  persist();
}

function fetchLyrics(title, artist) {
  title = sanitize(title);
  artist = sanitize(artist);
  if (!title) { return; }
  var key = title + '\u0001' + artist;
  if (key === lastLyricKey) { return; }
  lastLyricKey = key;
  st.lyrics = null;
  st.lyricsSynced = null;
  persist();
  var url1 = 'https://lrclib.net/api/search?track_name=' + encodeURIComponent(title) + (artist ? '&artist_name=' + encodeURIComponent(artist) : '');
  var url2 = 'https://lrclib.net/api/search?q=' + encodeURIComponent(title + ' ' + artist);
  curlJson(url1, function (arr) {
    if (arr && arr.length) { pickLyrics(arr, key); return; }
    curlJson(url2, function (arr2) {
      if (arr2 && arr2.length) { pickLyrics(arr2, key); }
      else { if (lastLyricKey === key) { persist(); } }
    }, 0);
  }, 0);
}

function handleItem(typeHex, codeHex, dataB64) {
  var code = hexToAscii(codeHex);
  if (code === 'minm') {
    st.title = decodeData(dataB64);
    st.active = true;
    st.hasArt = false;
    st.artSeq = st.artSeq + 1;
    persist();
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
  } else if (code === 'pcst' || code === 'pbeg') {
    st.active = true;
    prgrBase = 0; prgrAt = Date.now();
    persist();
  } else if (code === 'pcen' || code === 'pend' || code === 'pfls') {
    if (code !== 'pcen') { st.active = false; }
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

function openPipe() {
  var s = fs.createReadStream(PIPE, { encoding: 'utf8' });
  s.on('data', function (chunk) { buf += chunk; parseBuf(); });
  s.on('error', function () { setTimeout(openPipe, 1000); });
  s.on('end', function () { setTimeout(openPipe, 300); });
  s.on('close', function () { setTimeout(openPipe, 300); });
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
