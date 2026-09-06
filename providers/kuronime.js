const cheerio = require('cheerio-without-node-native');
const CryptoJS = require('crypto-js');

const TMDB_API_KEY = "68e094699525b18a70bab2f86b1fa706";
const BASE_URL = "https://kuronime.sbs";
const MIRROR_PASSWORD = "3&!Z0M,VIZ;dZW==";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function evpBytesToKey(passwordStr, saltHex, keyLengthBytes) {
    const password = CryptoJS.enc.Utf8.parse(passwordStr);
    const salt = CryptoJS.enc.Hex.parse(saltHex);
    
    let key = CryptoJS.lib.WordArray.create();
    let block = CryptoJS.lib.WordArray.create();
    
    while (key.sigBytes < keyLengthBytes) {
        let hasher = CryptoJS.algo.MD5.create();
        if (block.sigBytes > 0) {
            hasher.update(block);
        }
        hasher.update(password);
        hasher.update(salt);
        block = hasher.finalize();
        key.concat(block);
    }
    
    key.sigBytes = keyLengthBytes;
    return key;
}

function decodeMirrorPayload(encoded) {
    try {
        const wrapperBytes = CryptoJS.enc.Base64.parse(encoded.trim());
        const wrapperJsonStr = CryptoJS.enc.Utf8.stringify(wrapperBytes);
        const wrapper = JSON.parse(wrapperJsonStr);
        
        const cipherText = wrapper.ct;
        const ivHex = wrapper.iv;
        const saltHex = wrapper.s;
        
        const key = evpBytesToKey(MIRROR_PASSWORD, saltHex, 32);
        const iv = CryptoJS.enc.Hex.parse(ivHex);
        
        const cipherParams = CryptoJS.lib.CipherParams.create({
            ciphertext: CryptoJS.enc.Base64.parse(cipherText)
        });
        
        const decryptedBytes = CryptoJS.AES.decrypt(cipherParams, key, {
            iv: iv,
            mode: CryptoJS.mode.CBC,
            padding: CryptoJS.pad.Pkcs7
        });
        
        const decryptedStr = CryptoJS.enc.Utf8.stringify(decryptedBytes);
        return JSON.parse(decryptedStr);
    } catch (e) {
        console.error('[Kuronime] Decrypt mirror payload failed:', e.message);
        return null;
    }
}

function isDirectMedia(url) {
    const cleanUrl = url.split('?')[0].toLowerCase();
    
    // Pastikan bukan halaman embed HTML biasa (seperti .html atau .htm)
    if (cleanUrl.endsWith(".html") || cleanUrl.endsWith(".htm")) {
        return false;
    }
    
    // Pastikan URL memiliki path yang valid (bukan sekadar domain/host kotor akibat salah regex)
    const pathParts = cleanUrl.split('/');
    if (pathParts.length < 4 || pathParts[3] === "") {
        return false;
    }
    
    return cleanUrl.endsWith(".m3u8") || 
           cleanUrl.endsWith(".mp4") || 
           cleanUrl.includes("mime=video/mp4") || 
           cleanUrl.includes("mime=video%2fmp4") || 
           cleanUrl.includes("googlevideo") || 
           cleanUrl.includes("bloggerusercontent");
}

function getQualityFromUrl(url) {
    const match = url.match(/\b(2160|1440|1080|720|480|360|240)\b/);
    return match ? match[1] + "p" : "Auto";
}

function unpack(html) {
    const packerRegex = /eval\(function\(p,a,c,k,e,[rd]\)\{[\s\S]*?return\s+p[\s\S]*?\}\(([\s\S]*?)\)\)/;
    const match = html.match(packerRegex);
    if (!match) return html;
    try {
        const args = new Function(`return [${match[1]}]`)();
        let p = args[0], a = args[1], c = args[2], k = args[3], e = args[4], d = args[5];
        if (typeof k === 'string') k = k.split('|');
        
        const decode = function(w) {
            return (w < a ? '' : decode(Math.floor(w / a))) + 
                   ((w % a) > 35 ? String.fromCharCode((w % a) + 29) : (w % a).toString(36));
        };
        
        while (c--) {
            if (k[c]) {
                p = p.replace(new RegExp('\\b' + decode(c) + '\\b', 'g'), k[c]);
            }
        }
        return p;
    } catch (err) {
        return html;
    }
}

function inspectPlayerPage(playerUrl, referer, streams) {
    return fetch(playerUrl, {
        headers: {
            "Referer": referer,
            "User-Agent": USER_AGENT
        }
    })
    .then(res => res.text())
    .then(html => {
        // Unpack script mp4upload atau pemutar terkompresi lainnya
        const unpackedHtml = unpack(html);
        const cleanHtml = unpackedHtml.replace(/\\/g, '');
        const $ = cheerio.load(cleanHtml);
        const candidates = new Set();
        
        $('iframe, video, source').each((i, el) => {
            const element = $(el);
            const src = element.attr('src') || element.attr('data-src');
            if (src && src.startsWith('http')) {
                candidates.add(src.trim());
            }
        });
        
        // Memakai negative lookahead (?!\w) agar tidak menangkap domain ".mp4upload.com" sebagai ".mp4"
        const mediaRegex = /https?:\/\/[^"'\s<]+?(?:\.m3u8|\.mp4)(?!\w)|https?:\/\/[^"'\s<]+?(?:googlevideo|blogger|blogspot|bloggerusercontent)[^"'\s<]*/gi;
        let match;
        while ((match = mediaRegex.exec(cleanHtml)) !== null) {
            candidates.add(match[0]);
        }
        
        candidates.forEach(url => {
            if (isDirectMedia(url)) {
                streams.push({
                    name: "Kuronime",
                    title: `Mirror (${getQualityFromUrl(url)})`,
                    url: url,
                    quality: getQualityFromUrl(url),
                    headers: {
                        "Referer": playerUrl,
                        "User-Agent": USER_AGENT
                    }
                });
            }
        });
    })
    .catch(err => {
        console.error(`[Kuronime] Failed to inspect player page ${playerUrl}: ${err.message}`);
    });
}

function getAnimeTitle(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    return fetch(url, {
        headers: { "User-Agent": USER_AGENT }
    })
    .then(res => res.json())
    .then(data => {
        const title = mediaType === 'tv' ? data.name : data.title;
        const originalTitle = data.original_name || data.original_title || "";
        return { title, originalTitle };
    });
}

function searchKuronime(query) {
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
    return fetch(searchUrl, {
        headers: {
            "Referer": BASE_URL,
            "User-Agent": USER_AGENT
        }
    })
    .then(res => res.text())
    .then(html => {
        const $ = cheerio.load(html);
        const results = [];
        
        $('article.bs, div.listupd article.bs, li .imgseries a.series').each((i, el) => {
            const element = $(el);
            let anchor = element.is('a') ? element : element.find('a[href]');
            if (!anchor || anchor.length === 0) return;
            
            let href = anchor.attr('href');
            if (!href || !href.includes('/anime/')) return;
            
            let title = anchor.attr('title') || 
                        element.find('h2').text() || 
                        element.find('img').attr('alt') || 
                        anchor.text();
            
            if (title) {
                results.push({
                    title: title.trim(),
                    url: href.trim()
                });
            }
        });
        
        const seen = new Set();
        return results.filter(item => {
            if (seen.has(item.url)) return false;
            seen.add(item.url);
            return true;
        });
    });
}

function findBestMatch(results, targetTitle, originalTitle) {
    if (results.length === 0) return null;
    
    const clean = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanTarget = clean(targetTitle);
    const cleanOriginal = clean(originalTitle);
    
    for (const item of results) {
        const cleanItem = clean(item.title);
        if (cleanItem === cleanTarget || (cleanOriginal && cleanItem === cleanOriginal)) {
            return item;
        }
    }
    
    for (const item of results) {
        const cleanItem = clean(item.title);
        if (cleanItem.includes(cleanTarget) || cleanTarget.includes(cleanItem) || 
            (cleanOriginal && (cleanItem.includes(cleanOriginal) || cleanOriginal.includes(cleanItem)))) {
            return item;
        }
    }
    
    return results[0];
}

function getEpisodes(animeUrl) {
    return fetch(animeUrl, {
        headers: {
            "Referer": BASE_URL,
            "User-Agent": USER_AGENT
        }
    })
    .then(res => res.text())
    .then(html => {
        const $ = cheerio.load(html);
        const episodes = [];
        
        $('div.bixbox.bxcl li').each((i, el) => {
            const li = $(el);
            const anchor = li.find("a[href*='/nonton-']");
            if (!anchor || anchor.length === 0) return;
            
            const href = anchor.attr('href');
            if (!href) return;
            
            const rawTitle = anchor.text().trim();
            const epMatch = rawTitle.match(/Episode\s+(\d+(?:\.\d+)?)/i);
            const epNum = epMatch ? parseFloat(epMatch[1]) : null;
            
            episodes.push({
                title: rawTitle,
                episodeNum: epNum,
                url: href.trim()
            });
        });
        
        return episodes;
    });
}

function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
    console.log(`[Kuronime] Starting extraction for TMDB ID: ${tmdbId}, Type: ${mediaType}, Season: ${season}, Episode: ${episode}`);
    
    return getAnimeTitle(tmdbId, mediaType)
    .then(info => {
        console.log(`[Kuronime] TMDB title resolved: "${info.title}" (Original: "${info.originalTitle}")`);
        return searchKuronime(info.title)
            .then(searchResults => {
                if (searchResults.length === 0 && info.originalTitle) {
                    console.log(`[Kuronime] Title search empty, trying original title: "${info.originalTitle}"`);
                    return searchKuronime(info.originalTitle);
                }
                return searchResults;
            })
            .then(searchResults => {
                const matchedAnime = findBestMatch(searchResults, info.title, info.originalTitle);
                if (!matchedAnime) {
                    console.log(`[Kuronime] No match found on Kuronime for TMDB ID: ${tmdbId}`);
                    return [];
                }
                console.log(`[Kuronime] Found matched anime: "${matchedAnime.title}" -> ${matchedAnime.url}`);
                
                if (mediaType === 'movie') {
                    // Movie handling: resolve streams directly or find the single episode
                    return getEpisodes(matchedAnime.url)
                        .then(episodes => {
                            const episodeUrl = episodes.length > 0 ? episodes[0].url : matchedAnime.url;
                            return extractStreamsFromEpisode(episodeUrl);
                        });
                } else {
                    // Series TV handling: find the matched episode number
                    return getEpisodes(matchedAnime.url)
                        .then(episodes => {
                            episodes.sort((a, b) => {
                                if (a.episodeNum !== null && b.episodeNum !== null) {
                                    return a.episodeNum - b.episodeNum;
                                }
                                return 0;
                            });
                            
                            let targetEpisode = episodes.find(ep => ep.episodeNum === episode);
                            if (!targetEpisode && episodes.length >= episode) {
                                targetEpisode = episodes[episode - 1];
                            }
                            
                            if (!targetEpisode) {
                                console.log(`[Kuronime] Episode ${episode} not found`);
                                return [];
                            }
                            
                            console.log(`[Kuronime] Found matched episode: "${targetEpisode.title}" -> ${targetEpisode.url}`);
                            return extractStreamsFromEpisode(targetEpisode.url);
                        });
                }
            });
    })
    .catch(err => {
        console.error(`[Kuronime] Error in getStreams: ${err.message}`);
        return [];
    });
}

function extractStreamsFromEpisode(episodeUrl) {
    console.log(`[Kuronime] Extracting streams from: ${episodeUrl}`);
    const streams = [];
    
    return fetch(episodeUrl, {
        headers: {
            "Referer": BASE_URL,
            "User-Agent": USER_AGENT
        }
    })
    .then(res => res.text())
    .then(html => {
        const idMatch = html.match(/var\s+_0xa100d42aa\s*=\s*["']([^"']+)["']/);
        const encryptedId = idMatch ? idMatch[1] : null;
        
        if (!encryptedId) {
            console.log('[Kuronime] No encrypted ID found in page script');
            return inspectPageFallback(html, episodeUrl, streams);
        }
        
        console.log(`[Kuronime] Found encrypted ID: ${encryptedId}`);
        return fetch("https://animeku.org/api/v9/sources", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Origin": BASE_URL,
                "Referer": episodeUrl,
                "Accept": "application/json, text/plain, */*"
            },
            body: JSON.stringify({ id: encryptedId })
        })
        .then(res => res.json())
        .then(sourcesResponse => {
            const mirrorPayload = sourcesResponse.mirror ? decodeMirrorPayload(sourcesResponse.mirror) : null;
            const embedUrls = [];
            
            if (mirrorPayload) {
                if (mirrorPayload.embed) {
                    for (const quality in mirrorPayload.embed) {
                        const hosts = mirrorPayload.embed[quality];
                        for (const hostName in hosts) {
                            const url = hosts[hostName];
                            if (url && url.startsWith('http')) {
                                embedUrls.push({ url, quality });
                            }
                        }
                    }
                }
                if (mirrorPayload.filelions && mirrorPayload.filelions.startsWith('http')) {
                    embedUrls.push({ url: mirrorPayload.filelions, quality: 'Auto' });
                }
                if (mirrorPayload.blog && mirrorPayload.blog.startsWith('http')) {
                    embedUrls.push({ url: mirrorPayload.blog, quality: 'Auto' });
                }
                if (mirrorPayload.raw && mirrorPayload.raw.startsWith('http')) {
                    embedUrls.push({ url: mirrorPayload.raw, quality: 'Auto' });
                }
            }
            
            if (embedUrls.length === 0) {
                console.log('[Kuronime] Sources API returned no mirror links');
                return inspectPageFallback(html, episodeUrl, streams);
            }
            
            console.log(`[Kuronime] Found ${embedUrls.length} mirror urls to inspect`);
            const promises = embedUrls.map(item => {
                if (isDirectMedia(item.url)) {
                    streams.push({
                        name: "Kuronime",
                        title: `Mirror (${item.quality})`,
                        url: item.url,
                        quality: item.quality,
                        headers: {
                            "Referer": episodeUrl,
                            "User-Agent": USER_AGENT
                        }
                    });
                    return Promise.resolve();
                } else {
                    return inspectPlayerPage(item.url, episodeUrl, streams);
                }
            });
            
            return Promise.all(promises).then(() => {
                if (streams.length === 0) {
                    return inspectPageFallback(html, episodeUrl, streams);
                }
                return streams;
            });
        });
    });
}

function inspectPageFallback(episodeHtml, episodeUrl, streams) {
    console.log('[Kuronime] Running page fallback scraping...');
    const candidates = [];
    const $ = cheerio.load(episodeHtml);
    
    $('iframe[src], iframe[data-src]').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        if (src && src.startsWith('http')) {
            candidates.push(src.trim());
        }
    });
    
    if (candidates.length === 0) {
        return Promise.resolve(streams);
    }
    
    const promises = candidates.map(url => {
        return inspectPlayerPage(url, episodeUrl, streams);
    });
    
    return Promise.all(promises).then(() => streams);
    
}

module.exports = { getStreams };
