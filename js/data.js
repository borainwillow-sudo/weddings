(function () {
  function uid() {
    return (
      Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    );
  }

  function slugify(s) {
    return String(s)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  var TYPO_ROLES = [
    { key: "siteName", label: "Name", min: 16, max: 64 },
    { key: "nav", label: "Navigation", min: 9, max: 24 },
    { key: "pageTitle", label: "Page title", min: 9, max: 40 },
    { key: "meta", label: "Header meta", min: 9, max: 32 },
    { key: "body", label: "Body text", min: 10, max: 28 },
    { key: "caption", label: "Captions", min: 8, max: 24 },
  ];

  var WEIGHTS = [
    { value: 300, label: "Light" },
    { value: 400, label: "Regular" },
    { value: 500, label: "Medium" },
    { value: 700, label: "Bold" },
  ];

  function emptyHeader() {
    return { title: "", meta: "", quote: "", description: "" };
  }

  function galleryPage(title) {
    return {
      id: slugify(title) || uid(),
      title: title,
      type: "gallery",
      header: emptyHeader(),
      photos: [],
      texts: [],
    };
  }

  // Fallback used only if data.json cannot be fetched.
  var DEFAULT_DATA = {
    siteName: "Wedding Photography",
    cursor: { image: null, size: 32, hotspot: "topleft" },
    footer: { space: 45 },
    typography: {
      siteName: { weight: 400, size: 30 },
      nav: { weight: 400, size: 13 },
      pageTitle: { weight: 500, size: 14 },
      meta: { weight: 400, size: 14 },
      body: { weight: 400, size: 15 },
      caption: { weight: 400, size: 12 },
    },
    pages: [
      { id: "home", title: "Home", type: "gallery", header: emptyHeader(), photos: [] },
      {
        id: "weddings",
        title: "Weddings",
        type: "group",
        children: [galleryPage("Ceremony"), galleryPage("Reception")],
      },
      {
        id: "about",
        title: "About",
        type: "text",
        header: Object.assign(emptyHeader(), { title: "About" }),
        body: "Write your about text here.",
      },
      {
        id: "contact",
        title: "Contact",
        type: "text",
        header: Object.assign(emptyHeader(), { title: "Contact" }),
        body: "Add your contact details here.",
      },
    ],
  };

  window.WB = window.WB || {};
  Object.assign(window.WB, {
    uid: uid,
    slugify: slugify,
    emptyHeader: emptyHeader,
    galleryPage: galleryPage,
    TYPO_ROLES: TYPO_ROLES,
    WEIGHTS: WEIGHTS,
    DEFAULT_DATA: DEFAULT_DATA,
  });
})();
