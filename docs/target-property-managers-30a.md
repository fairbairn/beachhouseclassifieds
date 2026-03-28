# Target 30A Property Management Companies

This page stores the working target list for future scraper coverage planning.

## Notes

- Source: user-provided ranking and estimates.
- Last updated: 2026-03-28.
- RealJoy expectation: 140 properties (current expected target).
- Royal Destinations expectation: 143 properties (current expected target).

## Future Adapter Tracking Adds (2026-03-28)

| Company                | Manager Key      | URL                                                                |
| ---------------------- | ---------------- | ------------------------------------------------------------------ |
| Prominence on 30a      | prominence30a    | https://www.prominenceon30a.com/30a-vacation-rentals#q=*%3A*       |
| 30A Cottages           | 30acottages      | https://www.30acottagesandconcierge.com/vacation-rentals#q=*%3A*   |
| ELP Properties         | elp30a           | https://eluxuryproperties.com/30a                                  |
| Rosemary Beach Rentals | rosemarybeach30a | https://rosemarybeach.com/rentals/?beds=&plus_bed=1&sort_by=random |

## Latest Execution Updates

- Panhandle Getaways (`panhandle30a`): completed filtered production run using user-prioritized URL; 51 discovered, 51 detailed, 0 failed; conformance quality gates met on current filtered corpus.
- Sandpiper Vacation Rentals (`sandpiper30a`): completed full run at expected count; 106 discovered, 106 detailed, 0 failed; amenities/location selector tuning completed and conformance quality gates met.
- Stay at 30A Vacation Rentals (`stayat30a`): completed full production run from `https://www.stayat30avacationrentals.com/30a-vacation-rentals/`; 37 discovered, 37 detailed, 0 failed; expected-count and conformance thresholds met.
- Newman-Dailey (`ndrp.com`): intentionally parked as not applicable for now.

## Top 10 Coverage Snapshot (Deduced From Current Repo)

This is a best-effort deduction based on manager names and domains visible in existing scraper adapters/scripts.

| #   | Company                 | Website                  | Coverage status (repo deduction) | Evidence                        | Notes                               |
| --- | ----------------------- | ------------------------ | -------------------------------- | ------------------------------- | ----------------------------------- |
| 1   | 360 Blue                | 360blue.com              | Covered                          | Dedicated adapter/script exists | `360blue` adapter present           |
| 2   | Benchmark Management    | benchmark30a.com         | Covered                          | Dedicated adapter/script exists | `benchmark30a` adapter present      |
| 3   | RealJoy Vacations       | realjoy.com              | Covered                          | Dedicated adapter/script exists | `realjoy30a` adapter present        |
| 4   | Oversee                 | oversee.us               | Covered                          | Dedicated adapter/script exists | `oversee30a` adapter present        |
| 5   | LocalVR                 | golocalvr.com            | Covered                          | Dedicated adapter/script exists | `localvr30a` adapter present        |
| 6   | Royal Destinations      | royaldestinations.com    | Covered                          | Dedicated adapter/script exists | `royaldestinations` adapter present |
| 7   | Homeowner's Collection  | homeownerscollection.com | Not covered yet                  | No direct adapter/script found  | Candidate to add                    |
| 8   | Sanders Beach Rentals   | sandersbeachrentals.com  | Not covered yet                  | No direct adapter/script found  | Candidate to add                    |
| 9   | Scenic Stays            | scenicstays.com          | Not covered yet                  | No direct adapter/script found  | Candidate to add                    |
| 10  | Holiday Isle Properties | holidayisle.net          | Not applicable                   | Outside 30A focus area          | Excluded from target coverage       |

## Priority Gap (Top 10 Still Needing Coverage)

- Homeowner's Collection
- Sanders Beach Rentals
- Scenic Stays

## Full Target List

| #   | Company                               | Est. # Properties (30A) | Website                       |
| --- | ------------------------------------- | ----------------------- | ----------------------------- |
| 1   | 360 Blue                              | 600-700                 | 360blue.com                   |
| 2   | Benchmark Management                  | 500-800                 | benchmark30a.com              |
| 3   | RealJoy Vacations                     | 300-500                 | realjoy.com                   |
| 4   | Oversee                               | 250-400                 | oversee.us                    |
| 5   | LocalVR                               | 200-400                 | golocalvr.com                 |
| 6   | Royal Destinations                    | 150-300                 | royaldestinations.com         |
| 7   | Homeowner's Collection                | 200+                    | homeownerscollection.com      |
| 8   | Sanders Beach Rentals                 | 150-250                 | sandersbeachrentals.com       |
| 9   | Scenic Stays                          | 150-250                 | scenicstays.com               |
| 10  | Holiday Isle Properties (N/A)         | Not applicable          | holidayisle.net               |
| 11  | Newman-Dailey Resort Properties (N/A) | Not applicable          | ndrp.com                      |
| 12  | Stay on 30A                           | 100-200                 | stayon30a.com                 |
| 13  | 30A Luxury Vacations                  | 100-200                 | 30aluxuryvacations.com        |
| 14  | Dune Vacation Rentals                 | 100-200                 | dunevacationrentals.com       |
| 15  | Panhandle Getaways                    | 100-300                 | panhandlegetaways.com         |
| 16  | Exclusive 30A                         | 75-150                  | exclusive30a.com              |
| 17  | Ocean Reef Resorts                    | 100-200                 | oceanreefresorts.com          |
| 18  | Compass Resorts                       | 100-200                 | compassresorts.com            |
| 19  | Southern Vacation Rentals             | 150-300                 | southernresorts.com           |
| 20  | Five Star Properties                  | 75-150                  | fivestarpropertiesdestin.com  |
| 21  | Garrett Realty Services               | 75-150                  | garrettrealty.com             |
| 22  | Sandpiper Vacation Rentals            | 50-100                  | sandpipervacationrentals.com  |
| 23  | 30A Vacay                             | 50-120                  | 30a-vacay.com                 |
| 24  | 30A Escapes                           | 50-120                  | 30aescapes.com                |
| 25  | Stay at 30A Vacation Rentals          | 50-100                  | stayat30avacationrentals.com  |
| 26  | Dune Allen Realty                     | 50-150                  | beautifulbeach.com            |
| 27  | Emerald Coast By Owner                | 50-150                  | emeraldcoastbyowner.com       |
| 28  | Beach Blue Properties                 | 50-100                  | beachblueproperties.com       |
| 29  | Coast Property Management             | 50-100                  | coast-properties.com          |
| 30  | Grayt 30A Vacations                   | 30-80                   | grayt30avacations.com         |
| 31  | 30A Beach Properties                  | 30-80                   | 30abeachproperties.com        |
| 32  | Beachwalk Vacations                   | 25-75                   | beachwalkvacations.com        |
| 33  | Sunburst Beach Vacations              | 25-75                   | sunburstbeachvacations.com    |
| 34  | Rivard of South Walton                | 25-75                   | rivardnet.com                 |
| 35  | Diamond Gulf Rentals                  | 25-75                   | diamondgulfrentals.com        |
| 36  | Benchmark 30A (Luxury Division)       | 50-150                  | benchmark30a.com              |
| 37  | Bliss Beach Rentals                   | 20-60                   | blissbeachrentals.com         |
| 38  | Paradise Properties                   | 25-75                   | paradise30a.com               |
| 39  | Beach Habitats 30A                    | 20-60                   | beachhabitats30a.com          |
| 40  | Emerald Coast Destinations            | 20-60                   | emeraldcoastdestinations.com  |
| 41  | The Premier Property Group 30A        | 20-60                   | thepremierpg.com              |
| 42  | Salt Water Vacations                  | 20-60                   | saltwatervacay.com            |
| 43  | 30A Rental Company                    | 20-60                   | 30arentalcompany.com          |
| 44  | Gulf Blue Vacations                   | 20-60                   | gulfbluevacations.com         |
| 45  | Seahaven Properties                   | 15-50                   | seahavenproperties.com        |
| 46  | Blue Lupine Vacation Rentals          | 15-50                   | bluelupinevacations.com       |
| 47  | Anchor Vacation Rentals               | 15-50                   | anchorvacationrentals.com     |
| 48  | BeachyCations                         | 10-40                   | beachycations.com             |
| 49  | Paradise30A Rentals                   | 10-40                   | paradise30a.com               |
| 50  | Southern Sands Property Group         | 10-40                   | southernsands30a.com          |
| 51  | 30A Getaway Co                        | 10-40                   | 30agetawayco.com              |
| 52  | Coastal Dream Rentals                 | 10-40                   | coastaldreamrentals.com       |
| 53  | Emerald Coast Luxury Rentals          | 10-40                   | emeraldcoastluxuryrentals.com |
| 54  | Seaside Vacation Homes                | 10-40                   | seasidevacationhomes.com      |
| 55  | Rosemary Beach Cottage Rental Co      | 10-30                   | rosemarycottagerentals.com    |
| 56  | Beachfront Vacation Co                | 10-40                   | beachfrontvacationco.com      |
| 57  | Coastal Luxe Rentals                  | 10-40                   | coastalluxerentals.com        |
| 58  | Sand & Sea Vacation Rentals           | 10-40                   | sandandsearentals.com         |
| 59  | Gulf Coast Getaways                   | 10-40                   | gulfcoastgetaways.com         |
| 60  | Southern Breeze Rentals               | 10-40                   | southernbreezerentals.com     |
| 61  | Paradise Beach Homes 30A              | 10-40                   | paradisebeachhomes30a.com     |
| 62  | Salt Life Vacation Homes              | 10-40                   | saltlifevacationhomes.com     |
| 63  | Coastal Haven Rentals                 | 10-40                   | coastalhavenrentals.com       |
| 64  | Beach Escape 30A                      | 10-40                   | beachescape30a.com            |
| 65  | Emerald Waters Rentals                | 10-40                   | emeraldwatersrentals.com      |
| 66  | Coastal Keys Vacation Rentals         | 10-40                   | coastalkeysrentals.com        |
| 67  | Luxe 30A Rentals                      | 10-40                   | luxe30arentals.com            |
| 68  | Gulf View Vacation Rentals            | 10-40                   | gulfviewvacationrentals.com   |
| 69  | Ocean Breeze Rentals 30A              | 10-40                   | oceanbreezerentals30a.com     |
| 70  | Blue Horizon Vacation Homes           | 10-40                   | bluehorizonvacations.com      |
| 71  | Coastal Retreat Rentals               | 10-40                   | coastalretreatrentals.com     |
| 72  | Beach Nest Vacation Rentals           | 10-40                   | beachnestrentals.com          |
| 73  | Shoreline Vacation Rentals            | 10-40                   | shorelinevacationrentals.com  |
| 74  | Coastal Living Rentals                | 10-40                   | coastallivingrentals.com      |
| 75  | Southern Charm Vacations              | 10-40                   | southerncharmvacations.com    |
| 76  | Beach Bliss Rentals                   | 10-40                   | beachblissrentals.com         |
| 77  | Gulf Paradise Rentals                 | 10-40                   | gulfparadiserentals.com       |
| 78  | Coastal Sun Rentals                   | 10-40                   | coastalsunrentals.com         |
| 79  | Beach House Experts 30A               | 10-40                   | beachhouseexperts30a.com      |
| 80  | Emerald Escape Rentals                | 10-40                   | emeraldescapers.com           |
| 81  | Seaglass Vacation Rentals             | 10-40                   | seaglassvacationrentals.com   |
| 82  | Coastal Roots Rentals                 | 10-40                   | coastalrootsrentals.com       |
| 83  | Beach Haven 30A                       | 10-40                   | beachhaven30a.com             |
| 84  | Gulfside Retreats                     | 10-40                   | gulfside-retreats.com         |
| 85  | Coastal Dunes Rentals                 | 10-40                   | coastaldunesrentals.com       |
| 86  | Beachfront Bliss 30A                  | 10-40                   | beachfrontbliss30a.com        |
| 87  | Shore Thing Rentals                   | 10-40                   | shorethingrentals.com         |
| 88  | Emerald Stay Vacations                | 10-40                   | emeraldstayvacations.com      |
| 89  | Coastal Crown Rentals                 | 10-40                   | coastalcrownrentals.com       |
| 90  | Ocean Pearl Rentals                   | 10-40                   | oceanpearlrentals.com         |
| 91  | Beach Luxe Collective                 | 10-40                   | beachluxecollective.com       |
| 92  | Southern Tide Rentals                 | 10-40                   | southerntiderentals.com       |
| 93  | Coastal Comfort Rentals               | 10-40                   | coastalcomfortrentals.com     |
| 94  | Gulf Breeze Getaways                  | 10-40                   | gulfbreezegetaways.com        |
| 95  | Beachway Vacations                    | 10-40                   | beachwayvacations.com         |
| 96  | Coastal Elite Rentals                 | 10-40                   | coastaleliterentals.com       |
| 97  | Emerald Isle Retreats                 | 10-40                   | emeraldisleretreats.com       |
| 98  | Beach Dreams 30A                      | 10-40                   | beachdreams30a.com            |
| 99  | Shoreline Luxe Rentals                | 10-40                   | shorelineluxerentals.com      |
| 100 | Coastal Signature Homes               | 10-40                   | coastalsignaturehomes.com     |
