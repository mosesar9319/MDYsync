'use strict';

// Mercaz Daf Yomi's own copies of its shiurim, on MDY's file server -- the pure parts:
// no DOM, no network. Loaded as a plain <script> (window.MdyFiles) by the pages that
// play shiurim, and require()d directly by tests/functions/mdy-files.test.mjs.
//
// Many DafSync readers learn on filtered devices that block YouTube. MDY's website plays
// every shiur from plain files on its own server, not from YouTube, at addresses of one
// fixed shape:
//
//   https://cdn.mdydaf.com/<shiur|nbtd>/<english|hebrew>/<masechta>/<360|720|1080>/<daf>.mp4
//   https://cdn.mdydaf.com/<shiur|nbtd>/<english|hebrew>/<masechta>/mp3/<daf>.mp3
//
// "shiur" is the full shiur and "nbtd" (Nothing But The Daf) is what DafSync calls the
// Chazarah Daf. One file covers the whole daf, both amudim.
//
// The player plays that file in place of the YouTube video for an MDY shiur. Every
// DafSync sync was timed against the YouTube upload, so the file is used only when it is
// the same recording: same length to within a few seconds (checked against 407 published
// syncs in November 2026: 399 matched to within half a second, the other 8 differed by
// minutes and are exactly the case this check turns away).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MdyFiles = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const HOST = 'https://cdn.mdydaf.com';

  // Sefaria name -> the masechta's name in MDY's addresses. MDY uses the Ashkenazi
  // spelling, the same one dafsync.com's own addresses use (shared/masechtos.mjs --
  // tests/functions/mdy-files.test.mjs checks the two agree). Only Chullin and Bechoros
  // are confirmed on MDY's server so far; any other masechta's file that is not there
  // simply fails to load, and the player falls back to YouTube.
  const MASECHTA_SLUGS = {
    Berakhot: 'berachos', Shabbat: 'shabbos', Eruvin: 'eruvin', Pesachim: 'pesachim',
    Yoma: 'yoma', Sukkah: 'sukkah', Beitzah: 'beitzah', 'Rosh Hashanah': 'rosh-hashanah',
    Taanit: 'taanis', Megillah: 'megillah', 'Moed Katan': 'moed-katan', Chagigah: 'chagigah',
    Yevamot: 'yevamos', Ketubot: 'kesubos', Nedarim: 'nedarim', Nazir: 'nazir', Sotah: 'sotah',
    Gittin: 'gittin', Kiddushin: 'kiddushin', 'Bava Kamma': 'bava-kamma',
    'Bava Metzia': 'bava-metzia', 'Bava Batra': 'bava-basra', Sanhedrin: 'sanhedrin',
    Makkot: 'makkos', Shevuot: 'shevuos', 'Avodah Zarah': 'avodah-zarah', Horayot: 'horayos',
    Zevachim: 'zevachim', Menachot: 'menachos', Chullin: 'chullin', Bekhorot: 'bechoros',
    Arakhin: 'arachin', Temurah: 'temurah', Keritot: 'kereisos', Meilah: 'meilah',
    Niddah: 'niddah',
  };

  const QUALITIES = ['360', '720', '1080', 'audio'];
  const QUALITY_LABELS = { 360: '360p', 720: '720p', 1080: '1080p', audio: 'Audio only' };

  // Where an MDY shiur plays from: MDY's own server (the default -- it works on filtered
  // devices that block YouTube) or YouTube.
  const SOURCES = ['mdy', 'youtube'];
  const DEFAULT_SOURCE = 'mdy';
  const SOURCE_STORAGE_KEY = 'dafsync-video-source';
  const QUALITY_STORAGE_KEY = 'dafsync-mdy-quality';

  // How far apart (seconds) the file's length and the sync's recording may be and still
  // count as the same recording.
  const SAME_RECORDING_TOLERANCE = 3;

  const HEBREW_LETTERS = {
    א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9,
    י: 10, כ: 20, ך: 20, ל: 30, מ: 40, ם: 40, נ: 50, ן: 50, ס: 60, ע: 70, פ: 80, ף: 80, צ: 90, ץ: 90,
    ק: 100, ר: 200, ש: 300, ת: 400,
  };

  // "קיג" -> 113, "טו" -> 15. Null when it holds anything else.
  function hebrewNumber(text) {
    const letters = String(text || '').replace(/["'״׳]/g, '');
    if (!letters) return null;
    let total = 0;
    for (const letter of letters) {
      const value = HEBREW_LETTERS[letter];
      if (!value) return null;
      total += value;
    }
    return total;
  }

  // The daf a YouTube title names, when it names one: MDY's English titles read "Daf Yomi
  // Chullin Daf 86 by R' Eli Stefansky", its Hebrew ones "מרכז דף יומי - חולין דף קיג. - ...".
  // A daf link sometimes points at the recording of the next or previous daf (it covers
  // the tail of this one), so the recording's own daf comes from its title, not the ref.
  function dafFromTitle(title) {
    const text = String(title || '');
    const english = text.match(/\bDaf\s+(\d{1,3})\b/i);
    if (english) return Number(english[1]);
    // "דף יומי" (Daf Yomi) comes first in MDY's Hebrew titles; the daf is the other "דף".
    for (const match of text.matchAll(/דף\s+([א-ת"'״׳]{1,5})(?=[.:\s|]|$)/g)) {
      if (match[1] === 'יומי') continue;
      const number = hebrewNumber(match[1]);
      if (number) return number;
    }
    return null;
  }

  // Whether a YouTube source could be one of MDY's own uploads. The ref already says
  // whose shiur it is (another maggid's ref carries a marker, "Bekhorot 2a (Bornstein)"),
  // and many saved titles are cut short ("CHAZARAH - Chullin Daf 10 | \"Nothing but") or
  // missing, so a title only rules a source out when it names another maggid's channel.
  function isMdyTitle(title) {
    return !/Bornstein|Lakewood Daf Yomi|בורנשטיין/i.test(String(title || ''));
  }

  // The folder MDY keeps one shiur's files in ("https://cdn.mdydaf.com/shiur/english/chullin")
  // and the daf the recording is of, or null when there is nothing to try.
  //   ref:     { tractate, daf, variant ('regular'|'chazarah'), language ('en'|'he'), maggid }
  //   options: { title: the YouTube source's title, liveBroadcast: true for a livestream
  //              (never on MDY's server) }
  function shiurFolder(ref, options) {
    const opts = options || {};
    if (!ref || !ref.tractate) return null;
    if (ref.maggid && ref.maggid !== 'stefansky') return null;
    if (opts.liveBroadcast) return null;
    if (!isMdyTitle(opts.title)) return null;
    const slug = MASECHTA_SLUGS[ref.tractate];
    if (!slug) return null;
    const daf = dafFromTitle(opts.title) || Number(ref.daf);
    if (!Number.isInteger(daf) || daf < 2 || daf > 200) return null;
    const kind = ref.variant === 'chazarah' ? 'nbtd' : 'shiur';
    const language = ref.language === 'he' ? 'hebrew' : 'english';
    return { folder: `${HOST}/${kind}/${language}/${slug}`, daf };
  }

  // The address of MDY's file for one shiur in one quality ('360'|'720'|'1080'|'audio'),
  // or null when there is none to try. Same arguments as shiurFolder, plus options.quality.
  function fileUrl(ref, options) {
    const found = shiurFolder(ref, options);
    if (!found) return null;
    const quality = QUALITIES.includes(String(options && options.quality)) ? String(options.quality) : '720';
    if (quality === 'audio') return `${found.folder}/mp3/${found.daf}.mp3`;
    return `${found.folder}/${quality}/${found.daf}.mp4`;
  }

  // MDY's picture for the shiur, shown before it starts playing.
  function posterUrl(ref, options) {
    const found = shiurFolder(ref, options);
    return found ? `${found.folder}/thumb/${found.daf}.png` : null;
  }

  function isMdyFileUrl(url) {
    return typeof url === 'string' && url.startsWith(`${HOST}/`);
  }

  // The quality a file is in, read back from its address.
  function qualityOfUrl(url) {
    if (!isMdyFileUrl(url)) return null;
    if (/\/mp3\/\d+\.mp3$/.test(url)) return 'audio';
    const match = url.match(/\/(360|720|1080)\/\d+\.mp4$/);
    return match ? match[1] : null;
  }

  // Phones and slow or data-saving connections start on 360p (about a quarter of the
  // 720p file's size); everything else on 720p. A reader's own choice wins.
  function defaultQuality({ saved, narrowScreen, saveData, slowConnection } = {}) {
    if (QUALITIES.includes(String(saved))) return String(saved);
    if (narrowScreen || saveData || slowConnection) return '360';
    return '720';
  }

  // Same recording? Unknown on either side counts as yes: a daf with no sync has no
  // timings to throw off.
  function sameRecording(fileSeconds, syncedSeconds, tolerance) {
    const file = Number(fileSeconds);
    const synced = Number(syncedSeconds);
    if (!(file > 0) || !(synced > 0)) return true;
    return Math.abs(file - synced) <= (tolerance == null ? SAME_RECORDING_TOLERANCE : tolerance);
  }

  function normalizeSource(value) {
    return SOURCES.includes(value) ? value : DEFAULT_SOURCE;
  }

  return {
    HOST, MASECHTA_SLUGS, QUALITIES, QUALITY_LABELS, SOURCES, DEFAULT_SOURCE,
    SOURCE_STORAGE_KEY, QUALITY_STORAGE_KEY, SAME_RECORDING_TOLERANCE,
    hebrewNumber, dafFromTitle, isMdyTitle, shiurFolder, fileUrl, posterUrl, isMdyFileUrl, qualityOfUrl,
    defaultQuality, sameRecording, normalizeSource,
  };
});
