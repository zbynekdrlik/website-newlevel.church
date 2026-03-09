const galleryFiles = import.meta.glob("../content/gallery/photos/*.json", {
  eager: true,
});

const partyFiles = import.meta.glob("../content/party/photos/*.json", {
  eager: true,
});

export interface GalleryPhoto {
  image: string;
  caption: string;
  order: number;
}

export function getGalleryPhotos(): GalleryPhoto[] {
  return Object.values(galleryFiles)
    .map((mod: any) => mod.default || mod)
    .sort((a, b) => a.order - b.order);
}

export function getPartyPhotos(): GalleryPhoto[] {
  return Object.values(partyFiles)
    .map((mod: any) => mod.default || mod)
    .sort((a, b) => a.order - b.order);
}
