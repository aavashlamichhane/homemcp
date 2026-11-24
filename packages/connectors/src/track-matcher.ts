export interface LibraryTrackCandidate {
  id: string;
  title: string;
  artist: string;
  album?: string | undefined;
  path?: string | undefined;
  duration?: number | undefined;
}

export interface RequestedTrack {
  artist: string;
  title: string;
  video_id?: string | undefined;
}

export interface MatchedTrackResult {
  requested: RequestedTrack;
  matched: boolean;
  confidence: number;
  match_reason?: string | undefined;
  track?: LibraryTrackCandidate | undefined;
}

const YT_ID_IN_FILENAME_RE = /\[([A-Za-z0-9_-]{11})\]/;

export function extractYoutubeIdFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const m = YT_ID_IN_FILENAME_RE.exec(filePath);
  return m?.[1];
}

export function normalizeTrackText(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(
      /\((?:official\s*(?:music\s*)?(?:video|audio|lyric\s*video|visualizer)|lyrics?|hd|4k|remastered(?:\s*\d{4})?|explicit|clean|live|audio)\)/gi,
      ' ',
    )
    .replace(/\b(?:feat\.?|ft\.?|featuring)\b[^-(]*/gi, ' ')
    .replace(/[&+]/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlapScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const setA = new Set(a.split(' ').filter(Boolean));
  const setB = new Set(b.split(' ').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let hits = 0;
  for (const tok of setA) {
    if (setB.has(tok)) hits++;
  }
  return (2 * hits) / (setA.size + setB.size);
}

export function matchRequestedTracks(
  requested: readonly RequestedTrack[],
  library: readonly LibraryTrackCandidate[],
): MatchedTrackResult[] {
  const byVideoId = new Map<string, LibraryTrackCandidate>();
  const indexed = library.map((t) => {
    const ytId = extractYoutubeIdFromPath(t.path);
    if (ytId) byVideoId.set(ytId, t);

    // Handle "Artist - Title" embedded in track title if artist is generic
    let cleanTitle = t.title;
    let cleanArtist = t.artist;
    const dashIdx = cleanTitle.indexOf(' - ');
    if (dashIdx > 0 && (!cleanArtist || cleanArtist.toLowerCase() === 'unknown artist')) {
      cleanArtist = cleanTitle.slice(0, dashIdx);
      cleanTitle = cleanTitle.slice(dashIdx + 3);
    }

    return {
      raw: t,
      normTitle: normalizeTrackText(cleanTitle),
      normArtist: normalizeTrackText(cleanArtist),
    };
  });

  return requested.map((req) => {
    if (req.video_id && byVideoId.has(req.video_id)) {
      return {
        requested: req,
        matched: true,
        confidence: 1.0,
        match_reason: 'youtube_video_id',
        track: byVideoId.get(req.video_id),
      };
    }

    const reqTitle = normalizeTrackText(req.title);
    const reqArtist = normalizeTrackText(req.artist);

    let best: { score: number; track: LibraryTrackCandidate; reason: string } | undefined;

    for (const cand of indexed) {
      const titleScore = tokenOverlapScore(reqTitle, cand.normTitle);
      const artistScore = reqArtist ? tokenOverlapScore(reqArtist, cand.normArtist) : 1;
      const directScore = 0.65 * titleScore + 0.35 * artistScore;

      // Also check swapped Artist <-> Title
      const swappedScore = reqArtist
        ? 0.65 * tokenOverlapScore(reqTitle, cand.normArtist) +
          0.35 * tokenOverlapScore(reqArtist, cand.normTitle)
        : 0;

      const score = Math.max(directScore, swappedScore);
      const reason = swappedScore > directScore ? 'swapped_artist_title' : 'normalized_metadata';

      if (!best || score > best.score) {
        best = { score, track: cand.raw, reason };
      }
    }

    if (best && best.score >= 0.78) {
      return {
        requested: req,
        matched: true,
        confidence: Math.round(best.score * 100) / 100,
        match_reason: best.reason,
        track: best.track,
      };
    }

    return {
      requested: req,
      matched: false,
      confidence: best ? Math.round(best.score * 100) / 100 : 0,
    };
  });
}
