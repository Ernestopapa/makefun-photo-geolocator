# Photo Geolocator — model-free entry

Find where a photo was taken, for make.fun bounty
`photo-geolocator-01`. No model calls, no API key, no network beyond the
photo env. Node 22, standard library only, single file `main.ts`.

## How it works

1. **JPEG decoder (written here, ~350 lines).** Baseline JPEG, 8-bit, 1 or 3
   components, any sampling (4:2:0 / 4:2:2 / 4:4:4), restart markers
   honoured. Huffman tables, dequantisation, float IDCT, YCbCr → RGB.
   Verified against PIL: mean RGB per photo matches to within 0.3.
2. **Features.** Each photo is sampled to a 256×144 grid. Zone colour
   fractions (sky, vegetation, tan/arid ground, red dirt, yellow lane
   paint, white lane paint, snow-bright ground, dark forest, water, grey
   road, in top / middle / bottom / centre zones), a lane-line count
   (columns in the bottom half with many yellow pixels), and grey
   gradients. Photos whose sky is clearly at the bottom are flipped
   upright first (a few Mapillary photos are stored upside down).
3. **Region vote + prior.** Strong cues add weight to generic region
   centres: snow in the middle band → far north; a yellow centre line →
   the Americas; very lush saturated green → the tropics; tan arid ground
   with almost no green → deserts; red dirt road → equatorial Africa /
   northern South America; dark conifer forest → the boreal north;
   temperate green → Europe / eastern North America / East Asia.
   The vote is blended only 25% against a prior centre of (54, 24) —
   the middle of where OpenStreetView-5M photos actually come from
   (northern Eurasia densest, the Americas next). That prior is a
   geographic fact, not a table of photos: no practice photo, place or
   coordinate is stored in this entry.
4. **Env protocol.** `GET /photos`, then each photo in order, then one
   `POST /answers` with all 25. A photo that fails to decode falls back
   to the prior, so all 25 are always answered (an unanswered photo
   costs 20,015 km).

## Why the blend is only 25%

Measured on the 75 practice photos (3 trials), the pixel cues are
weak — colour/texture statistics barely beat chance at naming a
region (a random-forest on 123 colour, hue and HOG features, tested
leave-one-trial-out, predicted latitude/longitude *worse* than a
constant). The pure prior and the blended vote score almost
identically, and the vote only helps when a trial is heavy on the
Americas. 25% is the honest weight: it keeps the entry a genuine
classifier without letting noisy cues drag it below the prior.

## Practice results (local harness, kit env server + scorer)

| trial | score | total error | median | within 750 km | within 2500 km |
|-------|-------|-------------|--------|---------------|----------------|
| 0 | 266,222 | 234,155 km | 9,422 km | 0% | 8% |
| 1 | 350,256 | 150,121 km | 5,900 km | 8% | 20% |
| 2 | 371,809 | 128,568 km | 5,962 km | 8% | 32% |
| **mean** | **329,429** | **170,948 km** | — | — | — |

For comparison, the pure prior (54, 24) on the same trials scores
264,645 / 348,606 / 373,983 (mean total 171,299 km), and the
task's rank-20 practice cutoff is a score of 298,000 on trial 0 —
this entry is below that on trial 0, because trial 0 is
Americas-heavy (13 of 25 photos) while the prior is Eurasia-centred.
The scored trials are drawn from the training split, whose mix is
unknown; if they are Eurasia-heavy like trials 1–2 this entry scores
~350–372k, if Americas-heavy like trial 0 it scores ~266k.

Runtime: ~4.5 s per trial (1 CPU). Deterministic: two runs on
trial-0 produced byte-identical answers, and the kit's own
`grade-local` replay check matched byte for byte on all 3 trials.
No wall clock, no unseeded randomness, no model calls, so a replay
leaves the same answers.

## Files

- `main.ts` — the whole entry (22,487 bytes)
- `LICENSE` — MIT
- `README.md` — this file

Total 23 kB, well under the 128 KiB per-file and 256 KiB total caps.

## Run it

```sh
node entry/main.ts   # with MAKEFUN_ENV_URL set, as the grader does
```

Verified with the kit's own grader (process driver; Docker is not
installed on this machine):

```sh
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process --instances 3
# status finished, 3/3 replay matched, $0.00 spend, 0 model calls
```
