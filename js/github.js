(function () {
  var API = "https://api.github.com";
  var TOKEN_KEY = "wb_gh_token";
  var REPO_KEY = "wb_gh_repo";

  // Works out owner/repo from the GitHub Pages URL it's being served from.
  // borainwillow-sudo.github.io/weddings/ -> borainwillow-sudo / weddings
  function detectRepo() {
    var stored = localStorage.getItem(REPO_KEY);
    if (stored) return JSON.parse(stored);

    var host = location.hostname;
    var m = host.match(/^([^.]+)\.github\.io$/i);
    if (m) {
      var owner = m[1];
      var seg = location.pathname.split("/").filter(Boolean)[0];
      // A user/org root site (owner.github.io) lives in a repo of that name.
      var repo = seg || owner + ".github.io";
      return { owner: owner, repo: repo, branch: "main" };
    }
    // Served from a custom domain, where the address says nothing about where
    // the site lives. This is that repository, so fall back to it rather than
    // making someone type it in — anything stored above still wins, so it can
    // be pointed elsewhere from the Connect panel if it ever moves.
    return { owner: "borainwillow-sudo", repo: "weddings", branch: "main" };
  }

  function setRepo(owner, repo, branch) {
    localStorage.setItem(
      REPO_KEY,
      JSON.stringify({ owner: owner, repo: repo, branch: branch || "main" })
    );
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function setToken(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function hasToken() {
    return !!getToken();
  }

  async function api(path, options) {
    options = options || {};
    var token = getToken();
    if (!token) throw new Error("No GitHub token set.");
    var res = await fetch(API + path, {
      method: options.method || "GET",
      // Never read these from the browser cache. The branch head is fetched
      // from the same URL on every save; a cached answer means committing onto
      // a position the branch has already left, which GitHub rejects as "not a
      // fast forward" — and a cached answer would be re-served on every retry,
      // so the save could never succeed.
      cache: "no-store",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) {
      var detail = "";
      try {
        var j = await res.json();
        detail = j.message || "";
      } catch (e) {}
      if (res.status === 401) {
        throw new Error(
          "GitHub rejected the token (401). It may be expired or mistyped."
        );
      }
      if (res.status === 403) {
        throw new Error(
          "GitHub denied the request (403). The token likely lacks Contents: Read and write on this repository."
        );
      }
      if (res.status === 404) {
        throw new Error(
          "Repository or branch not found (404). Check the repo name and that the token can see it."
        );
      }
      var err = new Error(
        "GitHub error " + res.status + (detail ? ": " + detail : "")
      );
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return await res.json();
  }

  async function verify() {
    var repo = detectRepo();
    if (!repo) throw new Error("Could not work out which repository to save to.");
    // Confirms both that the token is valid and that it can reach this repo.
    var info = await api("/repos/" + repo.owner + "/" + repo.repo);
    if (!info.permissions || !info.permissions.push) {
      throw new Error(
        "That token can read the repository but not write to it. It needs Contents: Read and write."
      );
    }
    return { repo: repo, defaultBranch: info.default_branch };
  }

  // Commits any number of files in a single atomic commit using the Git Data
  // API. files: [{ path, content, encoding }] where encoding is
  // "utf-8" or "base64".
  async function commitFiles(files, message) {
    var repo = detectRepo();
    if (!repo) throw new Error("Could not work out which repository to save to.");
    var base = "/repos/" + repo.owner + "/" + repo.repo;
    var branch = repo.branch || "main";

    // Blobs are content-addressed and independent of where the branch is
    // pointing, so they're uploaded once and reused across retries. With a
    // batch of photos this is the slow part.
    var treeEntries = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var blob = await api(base + "/git/blobs", {
        method: "POST",
        body: {
          content: f.content,
          encoding: f.encoding === "base64" ? "base64" : "utf-8",
        },
      });
      treeEntries.push({
        path: f.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }

    // Uploading can take a while, and anything else pushing in the meantime
    // moves the branch on — GitHub then rejects the update as not a fast
    // forward. Rebuild on top of wherever the branch has got to and try again.
    // Our own files win; anything changed elsewhere is preserved by base_tree.
    // GitHub can also serve a briefly stale head from a read replica just
    // after a push, so give it room to catch up rather than failing fast.
    var attempts = 6;
    for (var attempt = 1; ; attempt++) {
      var ref = await api(base + "/git/ref/heads/" + branch);
      var baseCommitSha = ref.object.sha;
      var baseCommit = await api(base + "/git/commits/" + baseCommitSha);

      var tree = await api(base + "/git/trees", {
        method: "POST",
        body: { base_tree: baseCommit.tree.sha, tree: treeEntries },
      });

      var commit = await api(base + "/git/commits", {
        method: "POST",
        body: {
          message: message || "Update site content",
          tree: tree.sha,
          parents: [baseCommitSha],
        },
      });

      try {
        await api(base + "/git/refs/heads/" + branch, {
          method: "PATCH",
          body: { sha: commit.sha },
        });
        return commit.sha;
      } catch (err) {
        var raced = err.status === 422 || err.status === 409;
        if (!raced || attempt >= attempts) {
          if (raced) {
            throw new Error(
              "Could not save — the site was changed somewhere else at the same time. Close any other tab or device editing this site, then press Save now."
            );
          }
          throw err;
        }
        // Growing pause before rebasing onto the new head: 0.5s, 1s, 2s, 4s…
        await new Promise(function (r) {
          setTimeout(r, Math.min(4000, 500 * Math.pow(2, attempt - 1)));
        });
      }
    }
  }

  window.WB = window.WB || {};
  Object.assign(window.WB, {
    gh: {
      detectRepo: detectRepo,
      setRepo: setRepo,
      getToken: getToken,
      setToken: setToken,
      hasToken: hasToken,
      verify: verify,
      commitFiles: commitFiles,
    },
  });
})();
