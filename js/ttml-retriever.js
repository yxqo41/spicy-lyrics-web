import parseTTMLToLyrics from './ttml-parser.js';
import { settingsManager } from './settings-manager.js';
import { robustFetch } from './network-utils.js';

const SPICY_API_URL = 'https://api.spicylyrics.org';
const SPICY_VERSION = '2.8.0';
const CUSTOM_LYRICS_API = 'https://yxqo41main-spicy-player-db.hf.space';

/** Source label mapping */
const SOURCE_LABELS = {
  spl: 'Spicy Lyrics Community',
  aml: 'Apple Music',
  spt: 'Spotify',
  spicy: 'Spicy AMLL Player',
  spotify: 'Spotify',
  lrclib: 'LRCLIB',
  lyricsplus: 'LyricsPlus',
  netease: 'Netease',
  musixmatch: 'Musixmatch',
  genius: 'Genius',
  apple: 'Apple Music',
  custom: "Our Community's Lyrics",
};

function resolveSourceLabel(source, sourceDisplayName) {
  if (sourceDisplayName?.trim()) return sourceDisplayName.trim();
  if (source && SOURCE_LABELS[source]) return SOURCE_LABELS[source];
  if (source?.trim()) return source.trim();
  return 'Spicy AMLL Player';
}

// ═══════════════════════════════════════════════
// Helpers & Utilities
// ═══════════════════════════════════════════════

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fetch from custom TTML API */
async function fetchFromCustomAPI(songId) {
  try {
    const res = await fetch(`${CUSTOM_LYRICS_API}/lyrics/${songId}`);
    if (!res.ok) return null;

    const data = await res.json();
    if (!data || !data.ttml) return null;

    let lyricsData = parseTTMLToLyrics(data.ttml);
    if (lyricsData?.Type) {
      return {
        lyricsData,
        source: 'custom',
        sourceDisplayName: data.sourceDisplayName || `Synced by ${data.makerHandle || 'Community'}`,
        makerHandle: data.makerHandle,
        makerId: data.makerId
      };
    }
  } catch (e) {
    console.warn('[TTMLRetriever] Custom API fetch error:', e);
  }
  return null;
}

/** Proxy fetch to bypass CORS for specific providers */
async function proxiedFetch(url, options = {}) {
  try {
    return await robustFetch(url, options);
  } catch (e) {
    console.warn(`[TTMLRetriever] robustFetch failed for ${url}:`, e.message);
    throw e;
  }
}

// ═══════════════════════════════════════════════
// Spotify Search
// ═══════════════════════════════════════════════

let cachedSpotifyToken = null;

async function getSpotifyAccessToken() {
  if (cachedSpotifyToken) return cachedSpotifyToken;
  try {
    const targetUrl = 'https://open.spotify.com/get_access_token?reason=transport&productType=web_player';
    const res = await proxiedFetch(targetUrl, { credentials: 'omit' });
    if (res.ok) {
      const data = await res.json();
      if (data.accessToken) {
        cachedSpotifyToken = data.accessToken;
        return data.accessToken;
      }
    }
  } catch (e) {
    console.log('[TTMLRetriever] Spotify token error:', e.message);
  }
  return null;
}

async function searchSpotifyTrack(songName, artistName, albumName) {
  try {
    const token = await getSpotifyAccessToken();
    const query = encodeURIComponent(`track:${songName} artist:${artistName}`);
    const url = `https://api.spotify.com/v1/search?q=${query}&type=track&limit=5`;

    if (token) {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const tracks = data?.tracks?.items;
        if (tracks && tracks.length > 0) {
          return tracks[0].id;
        }
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

// Musixmatch Provider
// ═══════════════════════════════════════════════

async function fetchFromMusixmatch(songName, artistName, albumName, durationMs) {
  const durationSec = durationMs / 1000;

  try {
    const params = new URLSearchParams({
      provider: 'musixmatch',
      format: "json",
      namespace: "lyrics_richsynched",
      subtitle_format: "mxm",
      app_id: "web-desktop-app-v1.0",
      q_track: songName,
      q_artist: artistName,
      q_album: albumName || "",
      q_duration: durationSec
    });

    const res = await fetch(`/api/proxy?${params}`);
    if (!res.ok) return null;

    const data = await res.json();
    const macroCalls = data?.message?.body?.macro_calls;
    if (!macroCalls) return null;

    // Check for richsync (word sync)
    const ignoreWordSync = settingsManager.get("ignoreMusixmatchWordSync");
    const richsync = macroCalls["track.richsync.get"]?.message?.body?.richsync?.richsync_body;
    if (richsync && !ignoreWordSync) {
      // Note: Full RichSync parsing would be integrated here if ported from reference
    }

    // Fallback to subtitle (line sync)
    const subtitle = macroCalls["track.subtitles.get"]?.message?.body?.subtitle_list?.[0]?.subtitle?.subtitle_body;
    if (subtitle) {
      const lines = JSON.parse(subtitle);
      const content = lines.map((l, i) => ({
        Type: "Vocal",
        Text: l.text,
        StartTime: l.time.total,
        EndTime: (i < lines.length - 1) ? lines[i + 1].time.total : l.time.total + 4
      }));
      return {
        lyricsData: { Type: "Line", StartTime: content[0].StartTime, Content: content },
        source: "musixmatch",
        sourceDisplayName: "Musixmatch"
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════
// Netease Provider
// ═══════════════════════════════════════════════

async function fetchFromNetease(songName, artistName) {
  try {
    const searchUrl = `https://music.163.com/api/search/get?s=${encodeURIComponent(songName + " " + artistName)}&type=1&limit=1`;
    const searchRes = await proxiedFetch(searchUrl);
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    const songId = searchData?.result?.songs?.[0]?.id;
    if (!songId) return null;

    const lyricsUrl = `https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`;
    const lyricsRes = await proxiedFetch(lyricsUrl);
    if (!lyricsRes.ok) return null;

    const data = await lyricsRes.json();
    const lrc = data?.lrc?.lyric;
    if (!lrc) return null;

    // Use our existing parseLRC logic
    const lines = parseLRC(lrc, 240000); // 4 min duration fallback
    if (lines) {
      return {
        lyricsData: lines,
        source: "netease",
        sourceDisplayName: "NetEase"
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════
// LRCLIB
// ═══════════════════════════════════════════════

async function fetchFromLRCLIB(songName, artistName, albumName, durationSec) {
  try {
    const params = new URLSearchParams({
      track_name: songName,
      artist_name: artistName,
      album_name: albumName || '',
      duration: String(Math.round(durationSec)),
    });

    const res = await fetch(`https://lrclib.net/api/get?${params}`, {
      headers: { 'x-user-agent': 'spicy-amll-player/1.0' },
    });

    if (!res.ok) return null;
    const body = await res.json();
    return processLRCLIBResponse(body, durationSec * 1000);
  } catch (err) {
    return null;
  }
}

function processLRCLIBResponse(body, durationMs) {
  if (body?.syncedLyrics) {
    const lines = parseLRC(body.syncedLyrics, durationMs);
    if (lines) return { lyricsData: lines, source: 'lrclib', sourceDisplayName: 'LRCLIB' };
  }
  if (body?.plainLyrics) {
    const staticLines = body.plainLyrics.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(Text => ({ Text }));
    if (staticLines.length > 0) return { lyricsData: { Type: 'Static', Lines: staticLines }, source: 'lrclib', sourceDisplayName: 'LRCLIB' };
  }
  return null;
}

function parseLRC(lrcText, durationMs) {
  const rows = lrcText.split(/\r?\n/).map(r => r.trim()).filter(Boolean);
  const lines = [];
  rows.forEach(row => {
    const matches = Array.from(row.matchAll(/\[([0-9:.]+)\]/g));
    const text = row.replace(/\[[0-9:.]+\]/g, '').trim();
    if (!text || !matches.length) return;
    matches.forEach(match => {
      const ts = parseTimestamp(match[1]);
      if (ts !== null) lines.push({ text, startTimeMs: ts });
    });
  });
  if (!lines.length) return null;
  lines.sort((a, b) => a.startTimeMs - b.startTimeMs);
  const content = lines.map((line, i) => ({
    Type: 'Vocal',
    Text: line.text,
    StartTime: line.startTimeMs / 1000,
    EndTime: i < lines.length - 1 ? lines[i + 1].startTimeMs / 1000 : Math.max(line.startTimeMs / 1000 + 4, durationMs / 1000),
    OppositeAligned: false,
  }));
  return { Type: 'Line', StartTime: content[0]?.StartTime || 0, Content: content };
}

function parseTimestamp(ts) {
  const parts = ts.trim().split(':');
  if (parts.length < 2) return null;
  const minutes = parseInt(parts[0], 10);
  const seconds = parseFloat(parts[1]);
  return Math.round((minutes * 60 + seconds) * 1000);
}

// ═══════════════════════════════════════════════
// LyricsPlus Provider
// ═══════════════════════════════════════════════

function resolveSongwriters(metadata) {
  const songwriters = metadata?.songWriters || metadata?.songwriters;
  return Array.isArray(songwriters) ? songwriters : [];
}

async function fetchFromLyricsPlus(songName, artistName) {
  const trySearchWithArtist = async (artist) => {
    try {
      const params = new URLSearchParams({
        title: songName,
        artist: artist
      });

      const res = await fetch(`https://lyrics.geeked.wtf/v2/lyrics/get?${params}`, {
        headers: {
          'User-Agent': 'spicy-amll-player/1.0'
        }
      });

      if (!res.ok) return null;
      const data = await res.json();

      // Handle word/syllable-level sync (type: "Word")
      if (data.type === "Word" && data.lyrics && Array.isArray(data.lyrics)) {
        try {
          const lyricsData = convertLyricsPlusWordSync(data);
          if (lyricsData) {
            const songwriters = resolveSongwriters(data.metadata);
            if (songwriters.length > 0) {
              lyricsData.SongWriters = songwriters;
            }
            const result = {
              lyricsData,
              source: 'lyricsplus',
              sourceDisplayName: 'LyricsPlus'
            };
            // Attach songwriter metadata at both levels for compatibility
            if (songwriters.length > 0) {
              result.SongWriters = songwriters;
            }
            return result;
          }
        } catch (e) {
          console.warn('[TTMLRetriever] LyricsPlus word-sync parsing failed:', e);
        }
      }

      // Handle line-level sync (type: "Line")
      if (data.type === "Line" && data.lyrics && Array.isArray(data.lyrics)) {
        try {
          const lyricsData = convertLyricsPlusLineSync(data);
          if (lyricsData) {
            const songwriters = resolveSongwriters(data.metadata);
            if (songwriters.length > 0) {
              lyricsData.SongWriters = songwriters;
            }
            const result = {
              lyricsData,
              source: 'lyricsplus',
              sourceDisplayName: 'LyricsPlus'
            };
            // Attach songwriter metadata at both levels for compatibility
            if (songwriters.length > 0) {
              result.SongWriters = songwriters;
            }
            return result;
          }
        } catch (e) {
          console.warn('[TTMLRetriever] LyricsPlus line-sync parsing failed:', e);
        }
      }

      // Fallback to plain text lyrics
      if (data.lyrics && typeof data.lyrics === 'string' && data.lyrics.trim().length > 0) {
        const staticLines = data.lyrics
          .split(/\r?\n/)
          .map(l => l.trim())
          .filter(line => line.length > 0)
          .map(Text => ({ Text }));

        if (staticLines.length > 0) {
          const lyricsData = { Type: 'Static', Lines: staticLines };
          const songwriters = resolveSongwriters(data.metadata);
          if (songwriters.length > 0) {
            lyricsData.SongWriters = songwriters;
          }
          const result = {
            lyricsData,
            source: 'lyricsplus',
            sourceDisplayName: 'LyricsPlus'
          };
          if (songwriters.length > 0) {
            result.SongWriters = songwriters;
          }
          return result;
        }
      }
      return null;
    } catch (e) {
      console.warn(`[TTMLRetriever] LyricsPlus fetch error with artist "${artist}":`, e);
      return null;
    }
  };

  try {
    // Try with full artist name first
    let result = await trySearchWithArtist(artistName);
    if (result) return result;

    // If full artist search failed or returned empty, try with first artist (before "/")
    if (artistName.includes('/')) {
      const firstArtist = artistName.split('/')[0].trim();
      if (firstArtist && firstArtist !== artistName) {
        result = await trySearchWithArtist(firstArtist);
        if (result) return result;
      }
    }

    return null;
  } catch (e) {
    console.warn('[TTMLRetriever] LyricsPlus fetch error:', e);
    return null;
  }
}

function convertLyricsPlusWordSync(data) {
  const lines = data.lyrics;
  if (!lines || lines.length === 0) return null;

  // Extract agents from metadata (voice1, voice2, etc.)
  const agentMap = buildAgentMap(data.metadata?.agents || {});

  const content = lines.map(line => {
    // Convert times from milliseconds to seconds for player format
    const startTime = line.time / 1000;
    const endTime = (line.time + line.duration) / 1000;

    // Separate lead and background syllables
    const leadSyllables = [];
    const backgroundGroups = [];
    let currentBgGroup = null;

    const syllabusArray = line.syllabus || [];

    syllabusArray.forEach((syl, index) => {
      // Check if original text contains whitespace
      const hasWhitespace = /\s/.test(syl.text);
      
      // If has whitespace, use as-is; otherwise trim and use IsPartOfWord logic
      let syllableText, isPartOfWord;
      if (hasWhitespace) {
        syllableText = syl.text;
        isPartOfWord = false;
      } else {
        syllableText = syl.text.trim();
        // IsPartOfWord: true if there's a next syllable (continues without space)
        isPartOfWord = index < syllabusArray.length - 1;
      }
      
      const syllableObj = {
        Text: syllableText,
        StartTime: syl.time / 1000,
        EndTime: (syl.time + syl.duration) / 1000,
        IsPartOfWord: isPartOfWord
      };

      // Check for both synthetic and isBackground properties
      const isBackground = syl.synthetic || syl.isBackground;

      if (isBackground) {
        // Start or continue background group
        if (!currentBgGroup) {
          currentBgGroup = {
            StartTime: syllableObj.StartTime,
            Syllables: []
          };
        }
        currentBgGroup.Syllables.push(syllableObj);
        currentBgGroup.EndTime = syllableObj.EndTime;
      } else {
        // Close current background group if one exists
        if (currentBgGroup) {
          backgroundGroups.push(currentBgGroup);
          currentBgGroup = null;
        }
        leadSyllables.push(syllableObj);
      }
    });

    // Close any remaining background group
    if (currentBgGroup) {
      backgroundGroups.push(currentBgGroup);
    }

    // Determine agent ID for this line (duet support)
    const singerAlias = line.element?.singer;
    const agentId = singerAlias && agentMap[singerAlias] ? agentMap[singerAlias] : null;

    const lineObj = {
      Type: 'Vocal',
      Text: line.text,
      Lead: {
        StartTime: startTime,
        EndTime: endTime,
        Syllables: leadSyllables
      },
      OppositeAligned: agentId === 'v2' || agentId === 'v2000'
    };

    // Add background vocals if any
    if (backgroundGroups.length > 0) {
      lineObj.Background = backgroundGroups;
    }

    // Add agent ID for duet support
    if (agentId) {
      lineObj.AgentId = agentId;
    }

    return lineObj;
  });

  if (content.length === 0) return null;

  return {
    Type: 'Syllable',
    StartTime: content[0].Lead.StartTime,
    Content: content,
    Lines: content,
    // Store agents for the player's duet system
    Agents: Object.values(agentMap).reduce((acc, id) => {
      acc[id] = id === 'v2'; // v2 is opposite-aligned (right side)
      return acc;
    }, {})
  };
}

function convertLyricsPlusLineSync(data) {
  const lines = data.lyrics;
  if (!lines || lines.length === 0) return null;

  // Extract agents from metadata (voice1, voice2, etc.)
  const agentMap = buildAgentMap(data.metadata?.agents || {});

  const content = lines.map(line => {
    // Convert times from milliseconds to seconds for player format
    const startTime = line.time / 1000;
    const endTime = (line.time + line.duration) / 1000;

    // Determine agent ID for this line (duet support)
    const singerAlias = line.element?.singer;
    const agentId = singerAlias && agentMap[singerAlias] ? agentMap[singerAlias] : null;

    const lineObj = {
      Type: 'Vocal',
      Text: line.text,
      StartTime: startTime,
      EndTime: endTime,
      OppositeAligned: agentId === 'v2' || agentId === 'v2000'
    };

    // Add agent ID for duet support
    if (agentId) {
      lineObj.AgentId = agentId;
    }

    return lineObj;
  });

  if (content.length === 0) return null;

  return {
    Type: 'Line',
    StartTime: content[0].StartTime,
    Content: content,
    Lines: content,
    // Store agents for the player's duet system
    Agents: Object.values(agentMap).reduce((acc, id) => {
      acc[id] = id === 'v2'; // v2 is opposite-aligned (right side)
      return acc;
    }, {})
  };
}

function buildAgentMap(agentsObj) {
  const map = {};
  if (!agentsObj || typeof agentsObj !== 'object') return map;

  const entries = Object.entries(agentsObj);
  let voiceIndex = 1;

  for (const [alias, agentInfo] of entries) {
    if (!agentInfo) continue;
    
    // Use provided agent ID or generate one
    let agentId = agentInfo.id || agentInfo.agentId || `v${voiceIndex}`;
    
    // Normalize to v1, v2 format if not already
    if (!agentId.match(/^v\d+/)) {
      agentId = `v${voiceIndex}`;
    }

    map[alias] = agentId;
    voiceIndex++;
  }

  // Ensure v1 exists and v2 is marked as opposite
  if (!Object.values(map).includes('v1') && entries.length > 0) {
    const firstAlias = entries[0][0];
    map[firstAlias] = 'v1';
  }

  return map;
}

// ═══════════════════════════════════════════════
// Spicy AMLL Player API
// ═══════════════════════════════════════════════

async function fetchFromSpicyAPI(songId) {
  try {
    const token = await getSpotifyAccessToken();
    const res = await fetch(`${SPICY_API_URL}/query`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'spicylyrics-version': SPICY_VERSION,
        'SpicyLyrics-WebAuth': token ? `Bearer ${token}` : ''
      },
      body: JSON.stringify({
        queries: [{ operation: 'lyrics', variables: { id: songId, auth: 'SpicyLyrics-WebAuth' } }],
        client: { version: SPICY_VERSION }
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.queries?.[0]?.result;
    if (!result || result.httpStatus !== 200) return null;

    let lyricsData = result.data;
    if (typeof lyricsData === 'string') {
      lyricsData = parseTTMLToLyrics(lyricsData);
    }

    if (lyricsData?.Type) {
      const source = lyricsData.source || 'spicy';
      return {
        lyricsData,
        source,
        sourceDisplayName: resolveSourceLabel(source, lyricsData.sourceDisplayName)
      };
    }
  } catch (err) {
    return null;
  }
}

// ═══════════════════════════════════════════════
// Apple Music Provider
// ═══════════════════════════════════════════════

async function fetchFromAppleMusic(songName, artistName, albumName, trackId = null) {
  try {
    // Strategy 2: Artist + Song
    if (!trackId) {
      const q2 = encodeURIComponent(`${artistName} ${songName}`);
      let res2 = await proxiedFetch(`https://itunes.apple.com/search?term=${q2}&entity=song&limit=1`);
      if (res2.ok) {
        let data2 = await res2.json();
        if (data2.results && data2.results.length > 0) {
          trackId = data2.results[0].trackId;
        }
      }
    }

    if (!trackId) {
      console.log('[TTMLRetriever] Apple Music: Could not find track ID on iTunes.');
      return null;
    }
  
    console.log(`[TTMLRetriever] Apple Music: Using track ID ${trackId}, fetching TTML...`);

    // Use the proxy/api to get TTML
    const apiRes = await proxiedFetch(`https://api.spicyamll.online/api/getttmlam?song=${trackId}`, { skipProxy: true });
    if (!apiRes.ok) return null;

    const data = await apiRes.json();
    console.log('[TTMLRetriever] Apple Music API Full Response:', data);

    const ttmlCode = data?.raw?.data?.[0]?.attributes?.ttmlLocalizations;
    console.log('[TTMLRetriever] Apple Music Extracted TTML:', ttmlCode);

    if (!ttmlCode) {
      console.log('[TTMLRetriever] Apple Music: No TTML found for track ID.');
      return null;
    }

    let lyricsData = parseTTMLToLyrics(ttmlCode);
    if (lyricsData?.Type) {
      return {
        lyricsData,
        source: 'apple',
        sourceDisplayName: 'Apple Music'
      };
    }

    return null;
  } catch (e) {
    console.warn('[TTMLRetriever] Apple Music fetch error:', e);
    return null;
  }
}


// ═══════════════════════════════════════════════
// Main Entry Point
// ═══════════════════════════════════════════════

export async function retrieveTTML(songName, artistName, albumName, durationSec = 0, songId = null) {
  const order = settingsManager.get("lyricsSourceOrder") || DEFAULT_LYRICS_SOURCE_ORDER;
  const disabled = new Set(settingsManager.get("disabledLyricsSources") || []);
  const activeOrder = order.filter(p => !disabled.has(p));

  console.log(`[TTMLRetriever] Saved order: ${JSON.stringify(order)}`);
  console.log(`[TTMLRetriever] Disabled: ${JSON.stringify([...disabled])}`);
  console.log(`[TTMLRetriever] Sequential lookup: ${activeOrder.join(" -> ")}`);

  // Try custom/community API first using the song ID
  const finalSongId = songId || await searchAppleTrackId(songName, artistName, albumName);
  if (finalSongId) {
    console.log(`[TTMLRetriever] Checking community API for track ${finalSongId}...`);
    const customResult = await fetchFromCustomAPI(finalSongId);
    if (customResult) return customResult;
  }

  for (const providerId of activeOrder) {
    console.log(`[TTMLRetriever] Attempting ${providerId}...`);
    let result = null;

    try {
      if (providerId === "spicy" || providerId === "genius") {
        // [DISABLED] These providers are currently unavailable or disabled by the developer.
        // Skipping at the code level to avoid unnecessary requests/failures without clearing user settings.
        console.log(`[TTMLRetriever] ⏭ Skipping ${providerId} (disabled/unavailable)`);
        continue;
      } else if (providerId === "apple" || providerId === "aml") {
        result = await fetchFromAppleMusic(songName, artistName, albumName, finalSongId);
      } else if (providerId === "musixmatch") {
        result = await fetchFromMusixmatch(songName, artistName, albumName, durationSec * 1000);
      } else if (providerId === "netease") {
        result = await fetchFromNetease(songName, artistName);
      } else if (providerId === "lrclib") {
        result = await fetchFromLRCLIB(songName, artistName, albumName, durationSec);
      } else if (providerId === "lyricsplus") {
        result = await fetchFromLyricsPlus(songName, artistName);
      }

      if (result) {
        console.log(`[TTMLRetriever] ✓ Found lyrics via ${providerId}`);
        return result;
      }
    } catch (e) {
      console.warn(`[TTMLRetriever] ${providerId} failed:`, e);
    }
  }

  console.log('[TTMLRetriever] ✗ No lyrics found from any source');
  return null;
}

/** Helper to find Apple Music track ID without full lyrics fetch */
async function searchAppleTrackId(songName, artistName, albumName) {
  try {
    const q1 = encodeURIComponent(`${artistName} ${albumName || ''} ${songName}`);
    let res = await proxiedFetch(`https://itunes.apple.com/search?term=${q1}&entity=song&limit=1`);
    if (res.ok) {
      let data = await res.json();
      if (data.results && data.results.length > 0) {
        return data.results[0].trackId;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}
