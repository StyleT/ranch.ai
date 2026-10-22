// Append-only. Each entry runs once inside a transaction; the version is recorded in schema_migrations.
// Never edit an entry that has shipped; add a new one.
export const migrations: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'frames, detections, events, camera_counts',
    sql: `
      -- One row per frame the sampler kept. ts is UTC ISO-8601. reason: floor (time-based), change (scene gate),
      -- seed (seed recorder import), manual.
      CREATE TABLE frames (
        id      INTEGER PRIMARY KEY,
        ts      TEXT    NOT NULL,
        camera  TEXT    NOT NULL,
        path    TEXT    NOT NULL UNIQUE,
        width   INTEGER,
        height  INTEGER,
        bytes   INTEGER,
        change  REAL,
        reason  TEXT    NOT NULL CHECK (reason IN ('floor', 'change', 'seed', 'manual'))
      );
      CREATE INDEX frames_camera_ts ON frames (camera, ts);
      CREATE INDEX frames_ts ON frames (ts);

      -- Tier-1 detector output. Box in normalized image coordinates (0..1), origin top-left.
      CREATE TABLE detections (
        id         INTEGER PRIMARY KEY,
        frame_id   INTEGER NOT NULL REFERENCES frames (id) ON DELETE CASCADE,
        model      TEXT    NOT NULL,
        label      TEXT    NOT NULL,
        confidence REAL    NOT NULL,
        x          REAL    NOT NULL,
        y          REAL    NOT NULL,
        w          REAL    NOT NULL,
        h          REAL    NOT NULL,
        latency_ms REAL
      );
      CREATE INDEX detections_frame ON detections (frame_id);
      CREATE INDEX detections_model_label ON detections (model, label);

      -- PLAN.md 4.4. evidence_frames and crop_paths are JSON arrays of paths. verdict is set by a human.
      CREATE TABLE events (
        id              TEXT PRIMARY KEY,
        ts              TEXT NOT NULL,
        camera          TEXT NOT NULL,
        type            TEXT NOT NULL,
        confidence      REAL NOT NULL,
        tier_decided    INTEGER NOT NULL CHECK (tier_decided IN (1, 2, 3)),
        evidence_frames TEXT NOT NULL DEFAULT '[]',
        crop_paths      TEXT NOT NULL DEFAULT '[]',
        vlm_text        TEXT,
        claude_text     TEXT,
        cost_usd        REAL NOT NULL DEFAULT 0,
        latency_ms      REAL,
        trace_id        TEXT,
        verdict         TEXT CHECK (verdict IN ('true_positive', 'false_positive')),
        verdict_at      TEXT,
        payload         TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX events_ts ON events (ts);
      CREATE INDEX events_camera_type_ts ON events (camera, type, ts);

      -- Per-minute counts per camera and label (horse_count on MQTT). ts is the minute, UTC.
      CREATE TABLE camera_counts (
        ts     TEXT    NOT NULL,
        camera TEXT    NOT NULL,
        label  TEXT    NOT NULL,
        count  INTEGER NOT NULL,
        model  TEXT    NOT NULL,
        PRIMARY KEY (ts, camera, label)
      );
    `,
  },
  {
    version: 2,
    name: 'frames.kept retention marker',
    sql: `
      -- Retention policy (docs/FRAMES-AND-BASELINE.md): NULL = not evaluated yet, 1 = passed the policy and is
      -- kept until the age limit. Frames that fail are deleted (row + file).
      ALTER TABLE frames ADD COLUMN kept INTEGER;
      CREATE INDEX frames_camera_kept_ts ON frames (camera, kept, ts);
    `,
  },
  {
    version: 3,
    name: 'detections.raw_label',
    sql: `
      -- The model's own class before the taxonomy mapping (docs/TAXONOMY.md), e.g. "cow" for a label "horse".
      ALTER TABLE detections ADD COLUMN raw_label TEXT;
    `,
  },
  {
    version: 4,
    name: 'taxonomy_versions',
    sql: `
      -- Versions of the class taxonomy (docs/TAXONOMY-UI.md §2). Exactly one row is active; history is never rewritten.
      CREATE TABLE taxonomy_versions (
        id INTEGER PRIMARY KEY,
        created TEXT NOT NULL,
        author TEXT NOT NULL,
        note TEXT,
        json TEXT NOT NULL,
        parent_id INTEGER,
        score_json TEXT,
        gate TEXT,
        active INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX taxonomy_versions_active ON taxonomy_versions (active);
    `,
  },
  {
    version: 5,
    name: 'bursts and tracks',
    sql: `
      -- Bursts (docs/MODEL-YOLO26.md part B): a change keep may be followed by members 1 s apart while motion continues.
      -- burst_id = the head frame's id (the head has seq 0, members seq >= 1). The reason CHECK cannot be altered in
      -- SQLite, so members carry reason 'change' and are told apart by seq > 0.
      ALTER TABLE frames ADD COLUMN burst_id INTEGER;
      ALTER TABLE frames ADD COLUMN seq INTEGER;
      CREATE INDEX frames_burst ON frames (burst_id, seq);
      -- Short tracks across a burst: track = local id within the burst, seen = frames the track appears in,
      -- dx/dy = normalized displacement of the box centre from first to last appearance.
      ALTER TABLE detections ADD COLUMN track INTEGER;
      ALTER TABLE detections ADD COLUMN seen INTEGER;
      ALTER TABLE detections ADD COLUMN dx REAL;
      ALTER TABLE detections ADD COLUMN dy REAL;
    `,
  },
];
