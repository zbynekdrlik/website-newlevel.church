const galleryFiles = import.meta.glob("../content/gallery/photos/*.json", {
  eager: true,
});

const partyFiles = import.meta.glob("../content/party/photos/*.json", {
  eager: true,
});

export interface GalleryPhoto {
  image: string;
  caption: string;
  order?: number;
  dateAdded?: string;
}

const byOrder = (a: GalleryPhoto, b: GalleryPhoto) =>
  (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);

const byDateAddedDesc = (a: GalleryPhoto, b: GalleryPhoto) => {
  const dateDifference = Date.parse(b.dateAdded || "") - Date.parse(a.dateAdded || "");
  return dateDifference || byOrder(a, b);
};

export function getGalleryPhotos(): GalleryPhoto[] {
  return Object.values(galleryFiles)
    .map((mod: any) => mod.default || mod)
    .sort(byOrder);
}

export function getPartyPhotos(): GalleryPhoto[] {
  return Object.values(partyFiles)
    .map((mod: any) => mod.default || mod)
    .sort(byDateAddedDesc);
}
