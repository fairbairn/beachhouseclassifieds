export type ManagerScrapeTarget = {
  manager_name: string;
  website_url: string;
  strategy: "playwright-scroll" | "static-html";
  anchor_urls: string[];
  notes?: string;
};

export const MANAGER_SCRAPE_TARGETS: ManagerScrapeTarget[] = [
  {
    manager_name: "Stay on 30A",
    website_url: "https://stayon30a.com",
    strategy: "playwright-scroll",
    anchor_urls: [
      "https://stayon30a.com/search-results/?min_beds=3&sort_by=rotation&plus_oc=1",
    ],
    notes:
      "Search results load in pages of 24; click Load More until exhausted (4 pages, 79 listings at min_beds=3).",
  },
  {
    manager_name: "360 Blue",
    website_url: "https://www.360blue.com",
    strategy: "playwright-scroll",
    anchor_urls: ["https://www.360blue.com/travel-collections/30A"],
    notes: "Collection pages lazy-load listing cards while scrolling.",
  },
  {
    manager_name: "Benchmark Management",
    website_url: "https://www.benchmark30a.com",
    strategy: "playwright-scroll",
    anchor_urls: [
      "https://www.benchmark30a.com/emerald-coast-vacation-rentals#q=*%3A*",
    ],
    notes: "Search/listing pages may lazy-load and require scroll progression.",
  },
  {
    manager_name: "Ocean Reef Resorts",
    website_url: "https://www.oceanreefresorts.com",
    strategy: "playwright-scroll",
    anchor_urls: [
      "https://www.oceanreefresorts.com/vacation-rentals?type=4&location=3",
    ],
    notes:
      "30A homes filter uses type=4 and location=3; results are lazy-loaded and may require repeated scrolling.",
  },
  {
    manager_name: "Oversee",
    website_url: "https://oversee.us",
    strategy: "playwright-scroll",
    anchor_urls: [
      "https://oversee.us/vrp/search/results/?search%5Bmeta%5D%5Bnodeid%5D=&search%5Bmeta%5D%5Bnodeid%5D=&search%5BAdults%5D=1&search%5BChildren%5D=0&search%5BInfants%5D=0&search%5Bmeta%5D%5Bpets%5D=&search%5Bpets_count%5D=&search%5Bmeta%5D%5Bnodeid%5D=&search%5Bmeta%5D%5Bnodeid%5D=&search%5Barrival%5D=&search%5Bdeparture%5D=&search%5Bbedrooms%5D=3&search%5Bbathrooms%5D=1&search%5Bshowmax%5D=true&search%5BmetaOr%5D=0&search%5Bshow%5D=15&search%5Bsort%5D=random&search%5Battrs_exact%5D=1&search%5Bbedroom_exact%5D=0&search%5Bbathroom_exact%5D=0&search%5Bflexdays%5D=0&search%5Border%5D=10&search%5BAdults%5D=1&search%5BChildren%5D=0&search%5BInfants%5D=0&search%5Bpets_count%5D=&search%5Bmeta%5D%5Bpets%5D=&search%5Bpets_count%5D=",
    ],
    notes: "VRP search results can require scroll and pagination capture.",
  },
  {
    manager_name: "Exclusive 30A",
    website_url: "https://www.exclusive30a.com",
    strategy: "playwright-scroll",
    anchor_urls: ["https://www.exclusive30a.com/vacation-rentals"],
    notes:
      "Vacation-rentals index may lazy-load listings and pagination widgets.",
  },
  {
    manager_name: "Stay on 30A",
    website_url: "https://stayon30a.com",
    strategy: "playwright-scroll",
    anchor_urls: [
      "https://stayon30a.com/search-results/?sort_by=rotation&plus_oc=1",
    ],
    notes: "Search results require repeated Load More clicks until exhausted.",
  },
  {
    manager_name: "30A Luxury Vacations",
    website_url: "https://www.30aluxuryvacations.com",
    strategy: "playwright-scroll",
    anchor_urls: [
      "https://www.30aluxuryvacations.com/vacation-rentals#q=*%3A*",
    ],
    notes:
      "Rental inventory page may lazy-load via scrolling and result controls.",
  },
  {
    manager_name: "Beach Blue Properties",
    website_url: "https://www.beachblueproperties.com",
    strategy: "playwright-scroll",
    anchor_urls: ["https://www.beachblueproperties.com/30-a/"],
    notes:
      "Collection-style 30A landing pages may lazy-load cards and require scrolling.",
  },
  {
    manager_name: "RealJoy Vacations",
    website_url: "https://www.realjoy.com",
    strategy: "playwright-scroll",
    anchor_urls: [
      "https://www.realjoy.com/beach-rentals?checkin=&checkout=&location=2&sleeps=",
    ],
    notes:
      "Beach rentals page uses scroll-driven lazy loading; known to load large inventories.",
  },
  {
    manager_name: "Five Star Properties",
    website_url: "https://www.fivestargulfrentals.com",
    strategy: "playwright-scroll",
    anchor_urls: [
      "https://www.fivestargulfrentals.com/vacation-rentals/results/?searchform=1&cwrsearch=1&Location=30A%20West",
      "https://www.fivestargulfrentals.com/vacation-rentals/results/?searchform=1&cwrsearch=1&Location=30A%20East",
    ],
    notes: "Requires traversing both East and West 30A result sets.",
  },
  {
    manager_name: "LocalVR",
    website_url: "https://stay.golocalvr.com",
    strategy: "playwright-scroll",
    anchor_urls: [
      "https://stay.golocalvr.com/listings?utm_source=google&utm_content=general_campaign&utm_medium=cpc&utm_campaign=pmax_30a&utm_term=&gad_source=1&gad_campaignid=22674054626&gbraid=0AAAAApE4bV3KK3Fu31ffxWtMklNtCggVY&gclid=CjwKCAjwspPOBhB9EiwATFbi5JVCxtJGCOS-EZlBy4fK8uN7Lafvjy9oIonjYkIzIA1MW3M5eL6PbBoCdr0QAvD_BwE&city=Carillon+Beach%2CDestin%2CInlet+Beach%2CMiramar+Beach%2CPanama+City+Beach%2CRosemary+Beach%2CSanta+Rosa+Beach%2CSeacrest%2CSeagrove%2CWatersound&guests=1&view=list&adults=1&children=0&infants=0",
    ],
    notes:
      "Filtered LocalVR list view for 30A-area cities; may require lazy-load scrolling.",
  },
  {
    manager_name: "Royal Destinations",
    website_url: "https://www.royaldestinations.com",
    strategy: "playwright-scroll",
    anchor_urls: ["https://www.royaldestinations.com/vacation-rentals"],
    notes:
      "Rezfusion/Bluetent listing index with 30a-vacation-rentals detail pages and availability encoded in embedded booking payloads.",
  },
  {
    manager_name: "Coast Property Management",
    website_url: "https://www.coast-properties.com",
    strategy: "playwright-scroll",
    anchor_urls: [
      "https://www.coast-properties.com/search-results/?beds=&sort_by=price",
    ],
    notes:
      "Search results require explicit Load More interactions in addition to scrolling.",
  },
];
