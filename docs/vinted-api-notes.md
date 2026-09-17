# Vinted web API — what was actually observed

Captured on vinted.pt on 2026-09-16 from a signed-in browser session, by watching the
requests Vinted's own frontend makes. Nothing here comes from the original brief unless
marked; several of the brief's endpoints do not exist. Ids and logins below are from a
test session and are not secrets; no tokens are reproduced.

## Headers Vinted's frontend sends on `/api/v2/*`

| Header | Value | Where it comes from |
|---|---|---|
| `x-csrf-token` | a UUID | `"CSRF_TOKEN":"…"` in the page's RSC payload (`self.__next_f.push` chunks) |
| `x-anon-id` | a UUID | the `anon_id` cookie (also mirrored in the payload) |
| `accept` | `application/json, text/plain, */*` | |
| `content-type` | `application/json` on JSON POSTs | |

GET endpoints answered on cookies alone; the headers are sent anyway to match the real
client. Requests with no cookies get 401.

## Frontend

Next.js **App Router**. There is no `__NEXT_DATA__`. Server data is streamed as React
Server Components flight chunks: `self.__next_f.push([1, "…"])`. Item pages are
assembled from "plugin" blocks such as:

```json
{"name":"attributes","type":"attributes","section":"sidebar","data":{…}}
```

Key order varies between renders (data-first anonymous, name-first signed-in). The
attribute entries' `id` on `status` and `size` is **not** an entity id (50 was seen on
two different condition labels); only `brand` carries a real id (with a `/brand/{id}-…`
URL). Item pages are ~2 MB and rate-limited: HTTP 429 appeared at under one fetch per
second.

## Reading

| Purpose | Request | Notes |
|---|---|---|
| Signed-in user | `GET /api/v2/users/current` | `{"user":{id, login, path, …}}`; 403 when signed out |
| Any user | `GET /api/v2/users/{id}` | public |
| A user's listings | `GET /api/v2/wardrobe/{userId}/items?page=1&per_page=96&order=newest_first` | public, includes sold; `pagination.total_pages`; each item has `photos[].full_size_url` (the `/tc/` original), `price{amount,currency_code}`, `brand`, `size`, `status`, `favourite_count`, `view_count`, `is_closed`… |
| Own editable listing | `GET /api/v2/item_upload/items/{id}` | owner-only; 403 for sold listings. `{"item":{id,title,description,price,currency,catalog_id,brand_id,brand_dto,size_id,color1_id,color2_id,package_size_id,shipment_prices,item_attributes:[{code:"condition",ids:[n]}],photos,isbn,measurement_*,is_unisex,is_draft,…},"parcel":…}` |
| Category tree | `GET /api/v2/item_upload/catalogs` | `{"catalogs":[{id,title,catalogs:[…]}]}` recursive |
| Colours | `GET /api/v2/item_upload/colors` | `{"colors":[{id,title,hex,code}]}` |
| Brands for a category | `GET /api/v2/item_upload/brands?category_id={catalogId}` | `{"brands":[{id,title,…}]}` |
| Seller's closet counts | `GET /api/v2/closet/seller_filters` | `{"filters":[{name:"Active",count},…]}` |

Not real (404 with an HTML page): `GET /api/v2/items/{id}`, `GET /api/v2/users/{id}/items`,
`GET /api/v2/catalog/items` (anonymous). `GET /api/v2/items/{id}/details` returned a
generic HTML shell.

## Creating a listing (as the frontend does it)

Observed sequence for one listing with one photo:

1. `GET /api/v2/item_upload/catalogs`
2. `POST /api/v2/photos` — `multipart/form-data` with fields `photo[file]` (the
   image), `photo[temp_uuid]` (the upload session uuid) and `photo[type]=item`
   (verified: an upload with exactly these fields answered 200). Response:
   `{"id": 33379149812, "temp_uuid": "<upload session uuid>", "url": …,
   "thumbnails": […]}`. The `id` is the temporary photo id used at step 6.
3. `POST /api/v2/item_upload/suggestions/categories` with
   `{"image_metadata":[{"image_id":"<photo image id>","orientation":"0"}],"upload_session_id":"<uuid>"}`
   — optional; suggestion only.
4. `POST /api/v2/item_upload/attributes` with `{"attributes":[{"code":"category","value":[4915]}]}`
   — returns the attribute form for that category. Observed shape:
   `{"attributes":[{"code":"condition","configuration":{"options":[{"type":"group","options":[{"id":6,"title":"Novo com etiquetas"},{"id":1,"title":"Novo sem etiquetas"},{"id":2,"title":"Muito bom"},{"id":3,"title":"Bom"},…]}]}},…]}`
   — the real condition ids, which the listing page's attribute block does not carry.
5. `GET /api/v2/item_upload/brands?category_id=4915`, `GET /api/v2/item_upload/colors`,
   `POST /api/v2/item_price_suggestions` — optional lookups.
6. `POST /api/v2/item_upload/items` — the create. Observed body:

```json
{
  "item": {
    "id": null,
    "currency": "EUR",
    "temp_uuid": "<upload session uuid, same as the photo's temp_uuid>",
    "title": "Monster Energy Export - Iberia Edition",
    "description": "Cans are full and in perfect conditions!\n",
    "brand_id": 28917,
    "brand": "Monster Energy",
    "catalog_id": 4915,
    "isbn": null,
    "is_unisex": false,
    "ai_photo": false,
    "price": 12,
    "package_size_id": 1,
    "shipment_prices": { "domestic": null, "international": null },
    "color_ids": [1],
    "assigned_photos": [
      { "id": 33379149812, "orientation": 0, "ai_detected": false, "digital_source_type": [], "c2pa_read_error": "other" }
    ],
    "measurement_length": null,
    "measurement_width": null,
    "item_attributes": [ { "code": "condition", "ids": [6] } ],
    "manufacturer": null,
    "manufacturer_labelling": null
  },
  "push_up": false
}
```

   Response 200 (body not captured). The new item id then appears in
   `GET /api/v2/item_upload/upload_another_item_tip?item_id=10020059278`.

Mapping from a backup's `metadata.json` to this body: `catalogId → catalog_id`,
`brandId → brand_id` (+ `brand` title), `conditionId → item_attributes[condition].ids`,
`colorIds → color_ids`, `packageSizeId → package_size_id`, `sizeId → size_id` (when the
category has sizes), `price`, `currency`, `title`, `description`; photos must be
re-uploaded through `POST /api/v2/photos` first and referenced by the returned ids.
Sold listings have no `item_upload` record, so their ids come only from the page
(brand) and the catalog tree (catalog).

## Deleting

`POST /api/v2/items/{id}/delete` — **empty body, no content-type** (200). The same
call with `{}` and `content-type: application/json` answered 403 access_denied.
Closet counts drop immediately. Deleting an id that is already gone answers 404
`not_found`; the relist treats that as "nothing to delete" and goes on to create.
A listing Vinted itself has cancelled (no Edit/Bump buttons on its page) answers
403 `access_denied` to delete, so it cannot be relisted from the button.

**Relist ordering:** delete the original before creating the replacement. Vinted
rejects a create whose photos match a live listing, so create-then-delete gets both
cancelled. Delete first, then recreate from the backup.

**Create body** additionally needs, at the top level beside `item` and `push_up`:
`upload_session_id` (the same uuid as `item.temp_uuid`) and `parcel` (null when
shipping is default). Without `upload_session_id` the create answered 500 {"code":105}.
The create POST also carries headers `x-upload-form: true`,
`x-enable-dynamic-attribute-condition/size/video-game-rating: true` and `locale`;
without the dynamic-attribute headers the create answered 500 {"code":105} too.

## Bot protection on writes

Two direct `POST /api/v2/item_upload/items` calls made by script (same cookies,
same headers, same body as the form) were answered with a DataDome challenge —
403 with an HTML stub carrying `var dd={'rt':'c','cid':…,'hsh':…,'t':'bv',…}` and
`https://ct.captcha-delivery.com/c.js` — while the same create done through
Vinted's own form minutes later went through. The photo upload before it was not
challenged. The check page can be reconstructed as
`https://geo.captcha-delivery.com/captcha/?initialCid=<dd.cid>&hash=<dd.hsh>&cid=<datadome cookie>&t=<dd.t>&referer=<page>&s=<dd.s>&e=<dd.e>`
for a person to complete.

## Sign-in

`POST /web/api/auth/oauth` with `{"client_id":"web","scope":"user","username","password","fingerprint","grant_type":"password"}`
(or `assertion` for Google). Protected by DataDome: a Playwright-launched browser was
captcha'd then blocked at this step; a plain browser with a human at the keyboard was
fine. Do not automate this step.
