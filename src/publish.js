const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUD_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUD_SECRET = process.env.CLOUDINARY_API_SECRET;
const IG_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_USER_ID = process.env.INSTAGRAM_USER_ID;
const IG_VERSION = process.env.IG_GRAPH_VERSION || "v24.0";
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || "instagram-images";
const DAILY_LIMIT = Number(process.env.DAILY_POST_LIMIT || 50);
const INSTAGRAM_CAPTION = "DM me for automation 🤖";

function required(name, value) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}
for (const [name, value] of Object.entries({
  CLOUDINARY_CLOUD_NAME: CLOUD_NAME,
  CLOUDINARY_API_KEY: CLOUD_KEY,
  CLOUDINARY_API_SECRET: CLOUD_SECRET,
  INSTAGRAM_ACCESS_TOKEN: IG_TOKEN,
  INSTAGRAM_USER_ID: IG_USER_ID,
})) required(name, value);

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPOSITORY = process.env.GITHUB_REPOSITORY;
const STATE_PATH = "state.json";

async function githubRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub API error: ${JSON.stringify(data)}`);
  return data;
}

async function readState() {
  required("GITHUB_TOKEN", GH_TOKEN);
  required("GITHUB_REPOSITORY", GH_REPOSITORY);
  const url = `https://api.github.com/repos/${GH_REPOSITORY}/contents/${STATE_PATH}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 404) {
    return { nextIndex: 0, postedToday: 0, day: today(), sha: null };
  }
  const data = await response.json();
  if (!response.ok) throw new Error(`Unable to read state: ${JSON.stringify(data)}`);
  const decoded = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
  return { ...JSON.parse(decoded), sha: data.sha };
}

async function saveState(state) {
  const url = `https://api.github.com/repos/${GH_REPOSITORY}/contents/${STATE_PATH}`;
  const body = {
    message: "chore: update Instagram publishing state",
    content: Buffer.from(JSON.stringify({
      nextIndex: state.nextIndex,
      postedToday: state.postedToday,
      day: state.day,
    }, null, 2) + "\n").toString("base64"),
    branch: process.env.GITHUB_REF_NAME || "main",
  };
  if (state.sha) body.sha = state.sha;
  const result = await githubRequest(url, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return result.content.sha;
}

async function cloudinaryAssets() {
  const auth = Buffer.from(`${CLOUD_KEY}:${CLOUD_SECRET}`).toString("base64");
  const base = `https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUD_NAME)}`;
  const folderUrl =
    `${base}/resources/by_asset_folder?asset_folder=${encodeURIComponent(CLOUDINARY_FOLDER)}&max_results=500&direction=asc&fields=public_id,secure_url,format,created_at`;

  let response = await fetch(folderUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });
  let data;

  if (response.ok) {
    data = await response.json();
  } else {
    const prefixUrl =
      `${base}/resources/image/upload?prefix=${encodeURIComponent(CLOUDINARY_FOLDER + "/")}&max_results=500`;
    response = await fetch(prefixUrl, {
      headers: { Authorization: `Basic ${auth}` },
    });
    data = await response.json();
    if (!response.ok) {
      throw new Error(`Cloudinary asset listing failed: ${JSON.stringify(data)}`);
    }
  }

  const assets = (data.resources || [])
    .filter(a => a.secure_url)
    .sort((a, b) =>
      (a.created_at || "").localeCompare(b.created_at || "") ||
      String(a.public_id).localeCompare(String(b.public_id))
    );

  if (assets.length < 200) {
    throw new Error(`Found only ${assets.length} images in "${CLOUDINARY_FOLDER}". Need at least 200.`);
  }
  return assets.slice(0, 200);
}

async function graph(path, options = {}) {
  const response = await fetch(`https://graph.instagram.com/${IG_VERSION}/${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(`Instagram API error: ${JSON.stringify(data)}`);
  }
  return data;
}

async function createContainer(imageUrl) {
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption: INSTAGRAM_CAPTION,
    access_token: IG_TOKEN,
  });
  return graph(`${IG_USER_ID}/media?${params.toString()}`, { method: "POST" });
}

async function waitForContainer(id) {
  for (let i = 0; i < 24; i++) {
    const params = new URLSearchParams({
      fields: "status_code,status",
      access_token: IG_TOKEN,
    });
    const data = await graph(`${id}?${params.toString()}`);
    if (data.status_code === "FINISHED") return;
    if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
      throw new Error(`Instagram media container failed: ${JSON.stringify(data)}`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error("Instagram media container did not finish within 2 minutes.");
}

async function publishContainer(id) {
  const params = new URLSearchParams({ creation_id: id, access_token: IG_TOKEN });
  return graph(`${IG_USER_ID}/media_publish?${params.toString()}`, { method: "POST" });
}

async function main() {
  const state = await readState();
  const currentDay = today();

  if (state.day !== currentDay) {
    state.day = currentDay;
    state.postedToday = 0;
  }

  if (state.postedToday >= DAILY_LIMIT) {
    console.log(`Daily limit ${DAILY_LIMIT} reached for ${currentDay}.`);
    return;
  }

  const assets = await cloudinaryAssets();
  const imageNumber = state.nextIndex % 200;
  const asset = assets[imageNumber];

  console.log(`Publishing image ${imageNumber + 1}/200: ${asset.public_id}`);

  const container = await createContainer(asset.secure_url);
  await waitForContainer(container.id);
  const published = await publishContainer(container.id);

  state.nextIndex = (imageNumber + 1) % 200;
  state.postedToday += 1;
  state.sha = await saveState(state);

  console.log(JSON.stringify({
    success: true,
    instagram_media_id: published.id,
    image_number: imageNumber + 1,
    posted_today: state.postedToday,
    day: state.day,
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
