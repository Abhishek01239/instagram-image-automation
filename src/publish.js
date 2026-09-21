const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUD_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUD_SECRET = process.env.CLOUDINARY_API_SECRET;
const IG_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_USER_ID = process.env.INSTAGRAM_USER_ID;
const IG_VERSION = process.env.IG_GRAPH_VERSION || "v24.0";
const CLOUDINARY_FOLDER = "yt automation images";
const DAILY_LIMIT = Number(process.env.DAILY_POST_LIMIT || 50);
const INSTAGRAM_CAPTION = "DM me for automation 🤖";
const AUTOMATION_BUILD = "dynamic-image-count-v15-jpeg-extension-fix";
console.log(`Automation build: ${AUTOMATION_BUILD}`);

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

async function listCloudinary(url, auth, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Basic ${auth}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      data,
      resources: [],
    };
  }

  return {
    ok: true,
    status: response.status,
    data,
    resources: data.resources || [],
  };
}

async function cloudinaryAssets() {
  const auth = Buffer.from(`${CLOUD_KEY}:${CLOUD_SECRET}`).toString("base64");
  const base = `https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUD_NAME)}`;
    const folder = CLOUDINARY_FOLDER.trim().replace(/^\/+|\/+$/g, "");

  // Cloudinary has two folder modes. In dynamic folder mode,
  // /resources/by_asset_folder is the direct lookup. Search API
  // is also supported for both dynamic and legacy folder metadata.
  const searchExpressions = [
    {
      name: "search-asset-folder",
      expression: 'asset_folder:"yt automation images"',
    },
    {
      name: "search-asset-folder-wildcard",
      expression: 'asset_folder:"yt automation images/*"',
    },
    {
      name: "search-fixed-folder",
      expression: 'folder:"yt automation images"',
    },
  ];

  const candidates = [
    {
      name: "asset-folder",
      url: `${base}/resources/by_asset_folder?asset_folder=${encodeURIComponent(folder)}&max_results=500&direction=asc&fields=public_id,secure_url,format,created_at`,
    },
    {
      name: "public-id-prefix",
      url: `${base}/resources/image/upload?prefix=${encodeURIComponent(folder + "/")}&max_results=500&direction=asc`,
    },
  ];

  if (!folder.toLowerCase().startsWith("home/")) {
    candidates.push({
      name: "asset-folder-home-fallback",
      url: `${base}/resources/by_asset_folder?asset_folder=${encodeURIComponent("Home/" + folder)}&max_results=500&direction=asc&fields=public_id,secure_url,format,created_at`,
    });
    candidates.push({
      name: "public-id-prefix-home-fallback",
      url: `${base}/resources/image/upload?prefix=${encodeURIComponent("Home/" + folder + "/")}&max_results=500&direction=asc`,
    });
  }

  let lastStatus = null;
  let lastError = null;

  // Cloudinary Search API requires sort_by entries such as {created:"desc"}.
  // We request newest-first, then reverse locally so rotation stays oldest-first.
  for (const search of searchExpressions) {
    const url = base + "/resources/search";
    const result = await listCloudinary(url, auth, {
      method: "POST",
      body: {
        expression: search.expression,
        max_results: 500,
      },
    });
    lastStatus = result.status;
    if (!result.ok) {
      lastError = result.data;
      console.log(`Cloudinary lookup ${search.name}: HTTP ${result.status} ${JSON.stringify(result.data)}`);
      continue;
    }

    const assets = result.resources
      .filter(a => a.secure_url)
      .sort((a, b) =>
        (a.created_at || "").localeCompare(b.created_at || "") ||
        String(a.public_id).localeCompare(String(b.public_id))
      );

    console.log(`Cloudinary lookup ${search.name}: found ${assets.length} image(s).`);

    if (assets.length > 0) return assets;
  }

  // Direct prefix search for the actual uploaded assets. Cloudinary's dynamic-folder
  // API metadata can differ from the dashboard folder label, so try common public-ID
  // representations of the requested folder as well.
  const prefixVariants = [folder, `Home/${folder}`, `home/${folder}`];
  for (const prefix of prefixVariants) {
    const url = `${base}/resources/image/upload?prefix=${encodeURIComponent(prefix)}&max_results=500`;
    const result = await listCloudinary(url, auth);
    lastStatus = result.status;
    if (!result.ok) {
      lastError = result.data;
      console.log("Cloudinary lookup prefix-variant-" + prefix + ": HTTP " + result.status + " " + JSON.stringify(result.data));
      continue;
    }
    const assets = result.resources.filter(a => a.secure_url);
    console.log("Cloudinary lookup prefix-variant-" + prefix + ": found " + assets.length + " image(s).");
    if (assets.length > 0) return assets.sort((a,b) =>
      (a.created_at || "").localeCompare(b.created_at || "") || String(a.public_id).localeCompare(String(b.public_id))
    );
  }

  // Diagnostic: inspect a large global asset sample. If the dashboard shows 95
  // images but this API only sees the default sample assets, the credentials
  // are pointed at a different Cloudinary cloud/account (or the 95 assets are
  // not uploaded into this cloud).
  {
    const url = base + "/resources/image/upload?max_results=500&direction=asc";
    const result = await listCloudinary(url, auth);
    lastStatus = result.status;
    if (!result.ok) {
      lastError = result.data;
      console.log("Cloudinary lookup global-image-list: HTTP " + result.status + " " + JSON.stringify(result.data));
    } else {
      const folders = [...new Set(result.resources.map(a => String(a.asset_folder || "").trim()).filter(Boolean))];
      const nonSample = result.resources.filter(a => {
        const id = String(a.public_id || "");
        return id !== "sample" && !id.startsWith("samples/");
      });
      console.log("Cloudinary lookup global-image-list: found " + result.resources.length + " image(s) visible to these credentials.");
      console.log("Cloudinary global asset folders: " + JSON.stringify(folders));
      console.log("Cloudinary non-sample asset count: " + nonSample.length);
      for (const a of nonSample.slice(0, 50)) {
        console.log("Cloudinary non-sample asset: public_id=" + String(a.public_id || "") + " asset_folder=" + String(a.asset_folder || "") + " secure_url=" + String(a.secure_url || ""));
      }
      // The GitHub Actions log masks secret values. If the Cloudinary
      // asset_folder equals CLOUDINARY_FOLDER, the log may display it as "***".
      // Use the metadata returned by this global listing directly; this avoids
      // relying on Search API indexing for the folder.
      const wantedFolder = String(process.env.CLOUDINARY_FOLDER || folder).trim().replace(/^\/+|\/+$/g, "").toLowerCase();
      const folderGroups = new Map();
      for (const a of result.resources.filter(a => a.secure_url)) {
        const key = String(a.asset_folder || "").trim().replace(/^\/+|\/+$/g, "").toLowerCase();
        if (!key) continue;
        if (!folderGroups.has(key)) folderGroups.set(key, []);
        folderGroups.get(key).push(a);
      }

      const matchedFolderAssets = folderGroups.get(wantedFolder) || [];
      console.log("Cloudinary lookup global-image-list-folder-match: found " + matchedFolderAssets.length + " image(s).");

      if (matchedFolderAssets.length > 0) {
        return matchedFolderAssets.sort((a, b) =>
          (a.created_at || "").localeCompare(b.created_at || "") ||
          String(a.public_id).localeCompare(String(b.public_id))
        );
      }

      // GitHub Actions masks secret values in logs. If the requested folder
      // secret is masked in the API response, use the largest non-sample
      // asset-folder group as the folder-backed image set.
      const groupsBySize = [...folderGroups.entries()]
        .sort((a, b) => b[1].length - a[1].length);

      if (groupsBySize.length > 0) {
        const fallbackAssets = groupsBySize[0][1].sort((a, b) =>
          (a.created_at || "").localeCompare(b.created_at || "") ||
          String(a.public_id).localeCompare(String(b.public_id))
        );
        console.log("Cloudinary lookup global-image-list-largest-folder-fallback: found " + fallbackAssets.length + " image(s).");
        return fallbackAssets;
      }
    }
  }
  // If the Cloudinary UI folder name is not the same as the asset_folder
  // metadata, search images globally and match the requested folder locally.
  {
    const url = base + "/resources/search";
    const result = await listCloudinary(url, auth, {
      method: "POST",
      body: {
        expression: "resource_type:image",
        max_results: 500,
      },
    });
    lastStatus = result.status;
    if (!result.ok) {
      lastError = result.data;
      console.log("Cloudinary lookup search-all-images: HTTP " + result.status + " " + JSON.stringify(result.data));
    } else {
      const wanted = folder.toLowerCase();
      const assets = result.resources
        .filter(a => a.secure_url)
        .filter(a => {
          const assetFolder = String(a.asset_folder || "").replace(/^\/+|\/+$/g, "").toLowerCase();
          const publicId = String(a.public_id || "").toLowerCase();
          return assetFolder === wanted || assetFolder.startsWith(wanted + "/") ||
            publicId.startsWith(wanted + "/") || publicId.startsWith("home/" + wanted + "/");
        })
        .sort((a, b) =>
          (a.created_at || "").localeCompare(b.created_at || "") ||
          String(a.public_id).localeCompare(String(b.public_id))
        );
      console.log("Cloudinary lookup search-all-images: found " + assets.length + " matching image(s).");
      if (assets.length > 0) return assets;
    }
  }

  for (const candidate of candidates) {
    const result = await listCloudinary(candidate.url, auth);
    lastStatus = result.status;

    if (!result.ok) {
      lastError = result.data;
      console.log(`Cloudinary lookup ${candidate.name}: HTTP ${result.status} ${JSON.stringify(result.data)}`);
      continue;
    }

    const assets = result.resources
      .filter(a => a.secure_url)
      .sort((a, b) =>
        (a.created_at || "").localeCompare(b.created_at || "") ||
        String(a.public_id).localeCompare(String(b.public_id))
      );

    console.log(`Cloudinary lookup ${candidate.name}: found ${assets.length} image(s).`);

    if (assets.length > 0) {
      return assets;
    }
  }

  const detail = lastError ? ` Last API response: ${JSON.stringify(lastError)}` : "";
  throw new Error(
    `No images found using folder "${folder}". ` +
    `Tried Cloudinary Search API, asset-folder, and public-ID-prefix lookups (including a Home/ fallback). ` +
    `Last HTTP status: ${lastStatus}.${detail}`
  );
}

async function graph(path, options = {}) {
  const response = await fetch(`https://graph.instagram.com/${IG_VERSION}/${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(`Instagram API error: ${JSON.stringify(data)}`);
  }
  return data;
}

function instagramSafeImageUrl(imageUrl) {
  // Instagram needs a directly fetchable photo URL. Cloudinary's f_jpg
  // converts the bytes, but the delivery URL should also end in .jpg so
  // the fetched media has an unambiguous JPEG content type.
  // Normalize every image to an exact 4:5 canvas (1080x1350) without cropping.
  const marker = "/image/upload/";
  const index = imageUrl.indexOf(marker);
  if (index === -1) return imageUrl;

  const prefix = imageUrl.slice(0, index + marker.length);
  const rest = imageUrl.slice(index + marker.length);
  const lastSlash = rest.lastIndexOf("/");
  const dir = lastSlash >= 0 ? rest.slice(0, lastSlash + 1) : "";
  let filename = lastSlash >= 0 ? rest.slice(lastSlash + 1) : rest;

  // Remove the original extension. The explicit .jpg extension below makes
  // Cloudinary deliver the transformed asset as a real JPEG.
  filename = filename.replace(/\.[^.]+$/, "");
  if (!filename) filename = "image";

  return prefix +
    "c_pad,w_1080,h_1350,b_auto,q_auto/" +
    dir +
    filename +
    ".jpg";
}

async function createContainer(imageUrl) {
  const safeImageUrl = instagramSafeImageUrl(imageUrl);
  console.log("Instagram image normalized to 4:5 for publishing.");
  const params = new URLSearchParams({
    image_url: safeImageUrl,
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
  if (assets.length === 0) {
    throw new Error(`No images found in Cloudinary folder "${CLOUDINARY_FOLDER}".`);
  }

  const remainingToday = DAILY_LIMIT - state.postedToday;
  const postsThisRun = Math.min(remainingToday, assets.length);

  console.log(`Starting batch: publishing ${postsThisRun} image(s) this run. Current position: ${state.nextIndex + 1}/${assets.length}.`);

  for (let i = 0; i < postsThisRun; i++) {
    const imageNumber = state.nextIndex % assets.length;
    const asset = assets[imageNumber];

    console.log(`Publishing image ${imageNumber + 1}/${assets.length}: ${asset.public_id}`);

    const container = await createContainer(asset.secure_url);
    await waitForContainer(container.id);
    const published = await publishContainer(container.id);

    state.nextIndex = (imageNumber + 1) % assets.length;
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

  console.log(`Batch complete: ${state.postedToday}/${DAILY_LIMIT} posts today. Next image: ${state.nextIndex + 1}/${assets.length}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
