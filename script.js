/* ==========================================================================
   ⚙️  CONFIGURATION
   ========================================================================== */
const MAPBOX_TOKEN = 'pk.eyJ1IjoidGVzdHNtdGgiLCJhIjoiY21uMnltOHFsMWJsajJ3cTVnMHg1ZzRvdSJ9.7mnu46_XNxNp_v22_N67zA';
const MAPBOX_STYLE = 'mapbox://styles/testsmth/cmncy7s1r002q01s82gvv13jd';

/* --- GeoServer ---------------------------------------------------------- */
const GEO_BASE = 'http://localhost:8080/geoserver';
const GEO_WS   = 'niject04';
const GEO_WMS  = `${GEO_BASE}/wms`;

/* --- WMS Layer names ---------------------------------------------------- */
const WMS_LAYERS = {
    agb_2019:      `${GEO_WS}:AGB_2019`,
    agb_2023:      `${GEO_WS}:AGB_2023`,
    co2_2019:      `${GEO_WS}:CO2_2019`,
    co2_2023:      `${GEO_WS}:CO2_2023`,
    forest_2019:   `${GEO_WS}:Forest_Map_2019`,
    forest_2023:   `${GEO_WS}:Forest_Map_2023`,
    change_detect: `${GEO_WS}:ChiangMai_Change-002`
};

/* --- Mapbox vector tilesets --------------------------------------------- */
const MB = {
    amphoe:           { tileset: 'testsmth.9z3wq3lj',  layer: 'amphoe_cm-ac6h7s'        },
    point_forest:     { tileset: 'testsmth.1si4msyo',  layer: 'point_forest-5vl24a'     },
    point_non_forest: { tileset: 'testsmth.bv1rsk4l',  layer: 'point_non_forest-345cia' }
};

/* --- Local Shapefile paths (served from ./data/) ------------------------ */
const SHP_FOREST   = 'data/forest_boundary.zip';  // ~26 MB
const SHP_PROVINCE = 'data/province_cm.zip';       // ~0.4 MB

const MAP_CENTER             = [98.9853, 18.7883];
const MAP_ZOOM               = 8;
const RASTER_OPACITY_DEFAULT = 0.7;
const CM_BOUNDS              = [[97.3, 17.5], [100.0, 20.3]];

/* ==========================================================================
   🗺  MAP INIT
   ========================================================================== */
mapboxgl.accessToken = MAPBOX_TOKEN;

const map = new mapboxgl.Map({
    container: 'map',
    style:     MAPBOX_STYLE,
    center:    MAP_CENTER,
    zoom:      MAP_ZOOM
});

map.addControl(new mapboxgl.NavigationControl(), 'top-left');
map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-left');

/* ==========================================================================
   📂  LOADER HELPERS
   ========================================================================== */
function setLoaderMsg(msg, sub) {
    const m = document.getElementById('loader-msg');
    const s = document.getElementById('loader-sub');
    if (m) m.textContent = msg;
    if (s) s.textContent = (sub !== undefined) ? sub : '';
}

/**
 * Fetch a file with streamed download progress shown in the loader.
 * @param {string} url  - relative or absolute URL
 * @param {string} label - displayed in loader subtitle
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchWithProgress(url, label) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ไม่พบ ${url}`);

    const total  = parseInt(res.headers.get('content-length') || '0', 10);
    const reader = res.body.getReader();
    const chunks = [];
    let loaded   = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;

        const mb  = (loaded / 1_048_576).toFixed(1);
        const sub = total > 0
            ? `${Math.round(loaded / total * 100)}%  (${mb} / ${(total / 1_048_576).toFixed(1)} MB)`
            : `${mb} MB`;
        setLoaderMsg(`กำลังโหลด ${label}...`, sub);
    }

    const blob = new Blob(chunks);
    return blob.arrayBuffer();
}

/* ==========================================================================
   📦  SHAPEFILE LOADERS
   ========================================================================== */

/**
 * Load & parse forest boundary shapefile (26 MB, with progress).
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
async function loadForestShapefile() {
    const buf    = await fetchWithProgress(SHP_FOREST, 'ขอบเขตป่าไม้');
    setLoaderMsg('กำลังแปลง GeoJSON...', 'ขอบเขตป่าไม้ — กรุณารอสักครู่');
    const result = await shp(buf);
    return Array.isArray(result) ? result[0] : result;
}

/**
 * Load & parse province boundary shapefile (0.4 MB, silent).
 * @returns {Promise<GeoJSON.FeatureCollection|null>}
 */
async function loadProvinceShapefile() {
    try {
        const res  = await fetch(SHP_PROVINCE);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf  = await res.arrayBuffer();
        const result = await shp(buf);
        return Array.isArray(result) ? result[0] : result;
    } catch (e) {
        console.warn('[Shapefile] ไม่สามารถโหลด province_cm.zip:', e.message);
        return null;
    }
}

/* ==========================================================================
   🔀  PENDING VISIBILITY
   ========================================================================== */
const _pendingVis = {};

function setLayerVis(id, vis) {
    if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', vis);
    } else {
        _pendingVis[id] = vis;
    }
}

function flushPendingVis(...ids) {
    ids.forEach(id => {
        if (_pendingVis[id] !== undefined && map.getLayer(id)) {
            map.setLayoutProperty(id, 'visibility', _pendingVis[id]);
            delete _pendingVis[id];
        }
    });
}

function isCheckedInPanel(layerId) {
    // Matches exact data-layer="lyr_xxx" AND partial data-layer="lyr_xxx,lyr_yyy"
    const cb = document.querySelector(
        `input[data-layer="${layerId}"], input[data-layer*="${layerId}"]`
    );
    return cb ? cb.checked : false;
}

function wmsUrl(layerName) {
    return `${GEO_WMS}?bbox={bbox-epsg-3857}&format=image/png&service=WMS`
        + `&version=1.1.1&request=GetMap&srs=EPSG:3857`
        + `&transparent=true&width=256&height=256&layers=${layerName}`;
}

/* ==========================================================================
   📦  ADD ALL LAYERS  (called only after map + shapefiles are both ready)
   ========================================================================== */
function addAllLayers(forestGeoJSON, provinceGeoJSON) {

    /* ── 1. WMS Raster Layers ─────────────────────────────────────────── */
    const rasterDefs = [
        { id: 'lyr_agb_2019',      wms: WMS_LAYERS.agb_2019      },
        { id: 'lyr_agb_2023',      wms: WMS_LAYERS.agb_2023      },
        { id: 'lyr_co2_2019',      wms: WMS_LAYERS.co2_2019      },
        { id: 'lyr_co2_2023',      wms: WMS_LAYERS.co2_2023      },
        { id: 'lyr_forest_2019',   wms: WMS_LAYERS.forest_2019   },
        { id: 'lyr_forest_2023',   wms: WMS_LAYERS.forest_2023   },
        { id: 'lyr_change_detect', wms: WMS_LAYERS.change_detect }
    ];

    rasterDefs.forEach(({ id, wms }) => {
        map.addSource(`${id}_src`, { type: 'raster', tiles: [wmsUrl(wms)], tileSize: 256 });
        map.addLayer({
            id, type: 'raster', source: `${id}_src`,
            paint:  { 'raster-opacity': RASTER_OPACITY_DEFAULT },
            layout: { visibility: isCheckedInPanel(id) ? 'visible' : 'none' }
        });
    });

    /* ── 2. Province Boundary (Shapefile) ────────────────────────────── */
    if (provinceGeoJSON) {
        map.addSource('src_province_shape', { type: 'geojson', data: provinceGeoJSON });

        // Add casing layer (thick, dark) only if not already in Mapbox style
        if (!map.getLayer('lyr_province_casing')) {
            map.addLayer({
                id: 'lyr_province_casing', type: 'line',
                source: 'src_province_shape',
                paint: {
                    'line-color': '#1e3a5f',
                    'line-width': 4,
                    'line-opacity': 0.65
                },
                layout: { visibility: isCheckedInPanel('lyr_province_casing') ? 'visible' : 'none' }
            });
        }

        // Add inner line (thin, blue) only if not already in Mapbox style
        if (!map.getLayer('lyr_province_line')) {
            map.addLayer({
                id: 'lyr_province_line', type: 'line',
                source: 'src_province_shape',
                paint: {
                    'line-color': '#60a5fa',
                    'line-width': 2
                },
                layout: { visibility: isCheckedInPanel('lyr_province_line') ? 'visible' : 'none' }
            });
        }

        flushPendingVis('lyr_province_casing', 'lyr_province_line');
    }

    /* ── 3. Forest Boundary (Shapefile) ──────────────────────────────── */
    map.addSource('src_forest_shape', { type: 'geojson', data: forestGeoJSON });

    // Fill layer — semi-transparent green
    map.addLayer({
        id: 'lyr_forest_fill', type: 'fill',
        source: 'src_forest_shape',
        paint: {
            'fill-color': '#41ab5d',
            'fill-opacity': 0.30
        },
        layout: { visibility: isCheckedInPanel('lyr_forest_fill') ? 'visible' : 'none' }
    });

    // Outline layer — dark green border
    map.addLayer({
        id: 'lyr_forest_outline', type: 'line',
        source: 'src_forest_shape',
        paint: {
            'line-color': '#005a1a',
            'line-width': 1.5
        },
        layout: { visibility: isCheckedInPanel('lyr_forest_outline') ? 'visible' : 'none' }
    });

    flushPendingVis('lyr_forest_fill', 'lyr_forest_outline');
    setupPopup('lyr_forest_fill', 'ขอบเขตป่าไม้');

    /* ── 4. Amphoe (Mapbox Tileset) ───────────────────────────────────── */
    map.addSource('src_amphoe', { type: 'vector', url: `mapbox://${MB.amphoe.tileset}` });
    map.addLayer({
        id: 'lyr_amphoe_line', type: 'line',
        source: 'src_amphoe', 'source-layer': MB.amphoe.layer,
        paint: { 'line-color': '#94a3b8', 'line-width': 1, 'line-dasharray': [3, 2] },
        layout: { visibility: isCheckedInPanel('lyr_amphoe_line') ? 'visible' : 'none' }
    });
    setupPopup('lyr_amphoe_line', 'ขอบเขตอำเภอ');

    /* ── 5. Validation Points (Mapbox Tilesets) ───────────────────────── */
    map.addSource('src_pt_forest', { type: 'vector', url: `mapbox://${MB.point_forest.tileset}` });
    map.addLayer({
        id: 'lyr_point_forest', type: 'circle',
        source: 'src_pt_forest', 'source-layer': MB.point_forest.layer,
        paint: {
            'circle-radius': 5, 'circle-color': '#00441b',
            'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5
        },
        layout: { visibility: isCheckedInPanel('lyr_point_forest') ? 'visible' : 'none' }
    });
    setupPopup('lyr_point_forest', 'จุดตรวจสอบ: พื้นที่ป่าไม้');

    map.addSource('src_pt_nonforest', { type: 'vector', url: `mapbox://${MB.point_non_forest.tileset}` });
    map.addLayer({
        id: 'lyr_point_non_forest', type: 'circle',
        source: 'src_pt_nonforest', 'source-layer': MB.point_non_forest.layer,
        paint: {
            'circle-radius': 5, 'circle-color': '#d73027',
            'circle-stroke-color': '#000', 'circle-stroke-width': 1.5
        },
        layout: { visibility: isCheckedInPanel('lyr_point_non_forest') ? 'visible' : 'none' }
    });
    setupPopup('lyr_point_non_forest', 'จุดตรวจสอบ: นอกเขตป่า');

    /* ── 6. Init UI controls ─────────────────────────────────────────── */
    initSidebarControls();
    initPerLayerControls();
    updateLegend();
}

/* ==========================================================================
   🚀  BOOT SEQUENCE  — Map + Shapefiles load in parallel
   ========================================================================== */
const mapReady = new Promise(resolve => map.on('load', resolve));

(async function boot() {
    try {
        setLoaderMsg('กำลังโหลด...', 'แผนที่ + Shapefile พร้อมกัน');

        // Run map loading and both shapefile fetches simultaneously.
        // Province is small → no progress bar, errors are silently skipped.
        // Forest is large → shows streamed progress via setLoaderMsg.
        const [, forestGeoJSON, provinceGeoJSON] = await Promise.all([
            mapReady,
            loadForestShapefile(),
            loadProvinceShapefile()
        ]);

        setLoaderMsg('กำลังเพิ่ม Layer ลงแผนที่...', '');
        addAllLayers(forestGeoJSON, provinceGeoJSON);

        // Hide overlay only after all layers have been added
        setTimeout(() => {
            const loader = document.getElementById('shp-loader');
            if (loader) loader.style.display = 'none';
        }, 350);

    } catch (err) {
        console.error('[Boot Error]', err);
        setLoaderMsg('โหลดไม่สำเร็จ', err.message || 'เกิดข้อผิดพลาด');
    }
})();

/* ==========================================================================
   💬  POPUP HELPER
   ========================================================================== */
function setupPopup(layerId, title) {
    map.on('click', layerId, (e) => {
        if (map.getLayoutProperty(layerId, 'visibility') === 'none') return;
        const props = e.features[0].properties;
        let html = `<strong>${title}</strong><hr style="margin:5px 0;border-top:1px solid #ddd;">`;
        if (props.PV_TN)      html += `จังหวัด: <b>${props.PV_TN}</b><br>`;
        if (props.PV_EN)      html += `Province: ${props.PV_EN}<br>`;
        if (props.AP_TN)      html += `อำเภอ: <b>${props.AP_TN}</b><br>`;
        if (props.ftype_thai) html += `ประเภทป่า: ${props.ftype_thai}<br>`;
        if (props.p_name_t)   html += `จังหวัด: <b>${props.p_name_t}</b><br>`;
        if (props.rai)        html += `เนื้อที่: ${Number(props.rai).toLocaleString()} ไร่<br>`;
        if (props.area)       html += `พื้นที่: ${Number(props.area).toFixed(2)} ตร.กม.<br>`;
        html += `<details style="margin-top:6px;">
            <summary style="cursor:pointer;color:#15803d;font-size:12px;">ดู Attribute ทั้งหมด</summary>
            <ul style="padding-left:14px;margin:4px 0;font-size:11px;max-height:130px;overflow-y:auto;">`;
        for (const k in props) html += `<li><b>${k}:</b> ${props[k]}</li>`;
        html += `</ul></details>`;
        new mapboxgl.Popup({ maxWidth: '280px' }).setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', layerId, () => {
        if (map.getLayoutProperty(layerId, 'visibility') !== 'none')
            map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
}

/* ==========================================================================
   🔘  SIDEBAR — Toggle visibility + Section accordion
   ========================================================================== */
function initSidebarControls() {

    /* Layer visibility — supports comma-separated layer IDs */
    document.querySelectorAll('#sidebar input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
            const vis = cb.checked ? 'visible' : 'none';
            // Split "lyr_forest_fill,lyr_forest_outline" and toggle each
            cb.dataset.layer.split(',').forEach(id => setLayerVis(id.trim(), vis));
            updateLayerCountBadge();
            updateLegend();
        });
    });

    /* Section accordion */
    document.querySelectorAll('.sb-sec-hd').forEach(hd => {
        hd.addEventListener('click', () => {
            const body = document.getElementById(hd.dataset.sec);
            if (!body) return;
            const collapsed = body.classList.contains('collapsed');
            body.classList.toggle('collapsed', !collapsed);
            hd.classList.toggle('collapsed', !collapsed);
        });
    });

    /* Per-layer expand buttons */
    document.querySelectorAll('.lyr-opt-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const panel = document.getElementById(btn.dataset.panel);
            if (!panel) return;
            const isOpen = panel.classList.contains('open');
            panel.classList.toggle('open', !isOpen);
            btn.classList.toggle('open', !isOpen);
        });
    });

    updateLayerCountBadge();
}

/* ==========================================================================
   🎨  RASTER COLOR PALETTES  (Mapbox GL JS v3 raster-color expression)
   ========================================================================== */

/** Maps layer ID → palette-set key */
const RASTER_PALETTES = {
    lyr_agb_2019:    'agb',
    lyr_agb_2023:    'agb',
    lyr_co2_2019:    'co2',
    lyr_co2_2023:    'co2',
    lyr_forest_2019: 'forest',
    lyr_forest_2023: 'forest'
};

/**
 * Palette definitions.
 * type:'interpolate' → flat array [stop0,color0, stop1,color1, …] mapped via raster-value (0-1)
 * type:'step'        → [defaultColor, threshold1, color1, …] for classified rasters
 * stops:null         → reset to original WMS rendering
 */
const PALETTE_SETS = {
    agb: [
        {
            id: 'greens', label: 'Greens',
            tip: 'Scientific standard: low→high biomass (Mg/ha)',
            swatch: 'linear-gradient(to right,#f7fcf5,#c7e9c0,#74c476,#31a354,#004529)',
            type: 'interpolate',
            stops: [0,'#f7fcf5', 0.2,'#c7e9c0', 0.45,'#74c476', 0.7,'#31a354', 1,'#004529']
        },
        {
            id: 'viridis', label: 'Viridis',
            tip: 'Perceptually uniform, colorblind-friendly',
            swatch: 'linear-gradient(to right,#fde725,#5ec962,#21918c,#3b528b,#440154)',
            type: 'interpolate',
            stops: [0,'#fde725', 0.25,'#5ec962', 0.5,'#21918c', 0.75,'#3b528b', 1,'#440154']
        },
        {
            id: 'ylgn', label: 'YlGn',
            tip: 'Yellow → Green (IPCC standard)',
            swatch: 'linear-gradient(to right,#ffffe5,#d9f0a3,#78c679,#238443,#004529)',
            type: 'interpolate',
            stops: [0,'#ffffe5', 0.25,'#d9f0a3', 0.5,'#78c679', 0.75,'#238443', 1,'#004529']
        },
        {
            id: 'reset', label: 'ต้นฉบับ',
            tip: 'คืนสีจาก GeoServer SLD',
            swatch: null, stops: null
        }
    ],
    co2: [
        {
            id: 'ylorrd', label: 'YlOrRd',
            tip: 'Scientific standard for carbon stock',
            swatch: 'linear-gradient(to right,#ffffb2,#fecc5c,#fd8d3c,#f03b20,#bd0026)',
            type: 'interpolate',
            stops: [0,'#ffffb2', 0.25,'#fecc5c', 0.5,'#fd8d3c', 0.75,'#f03b20', 1,'#bd0026']
        },
        {
            id: 'plasma', label: 'Plasma',
            tip: 'Perceptually uniform, high contrast',
            swatch: 'linear-gradient(to right,#0d0887,#7e03a8,#cc4778,#f89540,#f0f921)',
            type: 'interpolate',
            stops: [0,'#0d0887', 0.25,'#7e03a8', 0.5,'#cc4778', 0.75,'#f89540', 1,'#f0f921']
        },
        {
            id: 'reds', label: 'Reds',
            tip: 'Single-hue: low → high carbon',
            swatch: 'linear-gradient(to right,#fff5f0,#fcbba1,#fb6a4a,#cb181d,#67000d)',
            type: 'interpolate',
            stops: [0,'#fff5f0', 0.25,'#fcbba1', 0.5,'#fb6a4a', 0.75,'#cb181d', 1,'#67000d']
        },
        {
            id: 'reset', label: 'ต้นฉบับ',
            tip: 'คืนสีจาก GeoServer SLD',
            swatch: null, stops: null
        }
    ],
    forest: [
        {
            id: 'natural', label: 'Natural',
            tip: 'ผลัดใบ=เขียวอ่อน / ไม่ผลัดใบ=เขียวเข้ม',
            swatch: 'linear-gradient(to right,#d9f0a3 49%,#006d2c 51%)',
            type: 'step',
            stops: ['#d9f0a3', 0.5, '#006d2c']
        },
        {
            id: 'contrast', label: 'Hi-Contrast',
            tip: 'แยกชัดเจน: ฟ้า-เขียว / เขียวเข้ม',
            swatch: 'linear-gradient(to right,#c7eae5 49%,#01665e 51%)',
            type: 'step',
            stops: ['#c7eae5', 0.5, '#01665e']
        },
        {
            id: 'browngr', label: 'Brown-Grn',
            tip: 'น้ำตาลทอง=ผลัดใบ / เขียว=ไม่ผลัดใบ',
            swatch: 'linear-gradient(to right,#d8b365 49%,#1b7837 51%)',
            type: 'step',
            stops: ['#d8b365', 0.5, '#1b7837']
        },
        {
            id: 'reset', label: 'ต้นฉบับ',
            tip: 'คืนสีจาก GeoServer SLD',
            swatch: null, stops: null
        }
    ]
};

/** Build a Mapbox raster-color expression from a palette entry. */
function buildColorExpr(palette) {
    if (!palette || !palette.stops) return undefined;
    if (palette.type === 'step') {
        // stops = [defaultColor, threshold1, color1, ...]
        const expr = ['step', ['raster-value'], ...palette.stops];
        return expr;
    }
    // interpolate: flat [stop, color, stop, color, ...]
    const expr = ['interpolate', ['linear'], ['raster-value']];
    for (let i = 0; i < palette.stops.length; i += 2) {
        expr.push(palette.stops[i], palette.stops[i + 1]);
    }
    return expr;
}

/** Apply or remove a named palette on a raster layer. */
function applyRasterPalette(layerId, paletteId) {
    if (!map.getLayer(layerId)) return;
    const setKey = RASTER_PALETTES[layerId];
    if (!setKey) return;
    const palette = PALETTE_SETS[setKey].find(p => p.id === paletteId);
    if (!palette) return;

    if (!palette.stops) {
        // Reset — remove raster-color to restore original WMS rendering
        map.setPaintProperty(layerId, 'raster-color', undefined);
        map.setPaintProperty(layerId, 'raster-color-mix',   undefined);
        map.setPaintProperty(layerId, 'raster-color-range', undefined);
    } else {
        // Apply luminance-based color ramp
        map.setPaintProperty(layerId, 'raster-color-mix',   [0.2126, 0.7152, 0.0722, 0]);
        map.setPaintProperty(layerId, 'raster-color-range', [0, 255]);
        map.setPaintProperty(layerId, 'raster-color', buildColorExpr(palette));
    }

    // Update active state of palette buttons for this layer
    document.querySelectorAll(`.pal-btn[data-pal-layer="${layerId}"]`).forEach(btn => {
        btn.classList.toggle('active', btn.dataset.palId === paletteId);
    });
}

/** Reset all palette paint properties on every raster layer. */
function resetAllPalettes() {
    Object.keys(RASTER_PALETTES).forEach(id => {
        if (map.getLayer(id)) {
            map.setPaintProperty(id, 'raster-color', undefined);
            map.setPaintProperty(id, 'raster-color-mix',   undefined);
            map.setPaintProperty(id, 'raster-color-range', undefined);
        }
    });
    document.querySelectorAll('.pal-btn').forEach(b => b.classList.remove('active'));
}

/* ==========================================================================
   🎨  PER-LAYER CONTROLS  (opacity + hue-rotate + saturation + contrast)
   ========================================================================== */
const LAYER_PRESETS = {
    vivid: { opacity: 0.85, hue: 0,   sat:  0.6, contrast:  0.3 },
    gray:  { opacity: 0.85, hue: 0,   sat: -1.0, contrast:  0.2 },
    reset: { opacity: 0.7,  hue: 0,   sat:  0.0, contrast:  0.0 }
};

function initPerLayerControls() {

    /* Inject hue / sat / contrast rows + preset buttons + palette row into every opt-panel */
    document.querySelectorAll('.lyr-opt-panel').forEach(panel => {
        const opRange = panel.querySelector('[data-layer-opacity]');
        if (!opRange) return;
        const id = opRange.dataset.layerOpacity;
        const firstRow = panel.querySelector('.opt-row');

        firstRow.insertAdjacentHTML('afterend', `
            <div class="opt-row">
                <span class="opt-lbl">Hue</span>
                <input type="range" class="opt-range" data-layer-hue="${id}" min="-180" max="180" step="1" value="0">
                <span class="opt-val">0°</span>
            </div>
            <div class="opt-row">
                <span class="opt-lbl">Sat</span>
                <input type="range" class="opt-range" data-layer-sat="${id}" min="-1" max="1" step="0.05" value="0">
                <span class="opt-val">0.00</span>
            </div>
            <div class="opt-row">
                <span class="opt-lbl">Con</span>
                <input type="range" class="opt-range" data-layer-contrast="${id}" min="-1" max="1" step="0.05" value="0">
                <span class="opt-val">0.00</span>
            </div>
            <div class="opt-preset-row">
                <button class="preset-btn" data-preset="vivid" data-layer="${id}">Vivid</button>
                <button class="preset-btn" data-preset="gray"  data-layer="${id}">Grayscale</button>
                <button class="preset-btn" data-preset="reset" data-layer="${id}">รีเซ็ต</button>
            </div>
        `);

        /* Palette row — only for WMS raster layers that have palette sets */
        const setKey = RASTER_PALETTES[id];
        if (setKey) {
            const palettes = PALETTE_SETS[setKey];
            const swatches = palettes.map(p => {
                if (p.swatch) {
                    return `<button class="pal-btn" data-pal-layer="${id}" data-pal-id="${p.id}"
                        title="${p.tip || p.label}"
                        style="background:${p.swatch};"></button>`;
                }
                // reset button — no gradient
                return `<button class="pal-btn pal-reset" data-pal-layer="${id}" data-pal-id="${p.id}"
                    title="${p.tip || p.label}">&#8635;</button>`;
            }).join('');
            panel.insertAdjacentHTML('beforeend', `
                <div class="pal-row">
                    <span class="pal-row-lbl">Palette</span>
                    <div class="pal-swatches">${swatches}</div>
                </div>
            `);
        }
    });

    /* Opacity */
    document.querySelectorAll('[data-layer-opacity]').forEach(r => {
        const id  = r.dataset.layerOpacity;
        const vsp = r.closest('.opt-row').querySelector('.opt-val');
        r.addEventListener('input', () => {
            const v = parseFloat(r.value);
            if (vsp) vsp.textContent = Math.round(v * 100) + '%';
            if (map.getLayer(id)) map.setPaintProperty(id, 'raster-opacity', v);
        });
    });

    /* Hue rotate */
    document.querySelectorAll('[data-layer-hue]').forEach(r => {
        const id  = r.dataset.layerHue;
        const vsp = r.closest('.opt-row').querySelector('.opt-val');
        r.addEventListener('input', () => {
            if (vsp) vsp.textContent = r.value + '°';
            if (map.getLayer(id)) map.setPaintProperty(id, 'raster-hue-rotate', parseFloat(r.value));
        });
    });

    /* Saturation */
    document.querySelectorAll('[data-layer-sat]').forEach(r => {
        const id  = r.dataset.layerSat;
        const vsp = r.closest('.opt-row').querySelector('.opt-val');
        r.addEventListener('input', () => {
            const v = parseFloat(r.value);
            if (vsp) vsp.textContent = v.toFixed(2);
            if (map.getLayer(id)) map.setPaintProperty(id, 'raster-saturation', v);
        });
    });

    /* Contrast */
    document.querySelectorAll('[data-layer-contrast]').forEach(r => {
        const id  = r.dataset.layerContrast;
        const vsp = r.closest('.opt-row').querySelector('.opt-val');
        r.addEventListener('input', () => {
            const v = parseFloat(r.value);
            if (vsp) vsp.textContent = v.toFixed(2);
            if (map.getLayer(id)) map.setPaintProperty(id, 'raster-contrast', v);
        });
    });

    /* Palette buttons — event delegation */
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.pal-btn');
        if (!btn) return;
        applyRasterPalette(btn.dataset.palLayer, btn.dataset.palId);
    });

    /* Preset buttons — use event delegation */
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.preset-btn');
        if (!btn) return;
        const id    = btn.dataset.layer;
        const p     = LAYER_PRESETS[btn.dataset.preset];
        const panel = btn.closest('.lyr-opt-panel');
        if (!p || !panel) return;

        const set = (attr, val, fmt) => {
            const r = panel.querySelector(`[data-layer-${attr}="${id}"]`);
            if (!r) return;
            r.value = String(val);
            const vsp = r.closest('.opt-row').querySelector('.opt-val');
            if (vsp) vsp.textContent = fmt(val);
            r.dispatchEvent(new Event('input'));
        };

        set('opacity',  p.opacity,  v => Math.round(v * 100) + '%');
        set('hue',      p.hue,      v => v + '°');
        set('sat',      p.sat,      v => v.toFixed(2));
        set('contrast', p.contrast, v => v.toFixed(2));
    });
}

/* ==========================================================================
   🏷  LAYER COUNT BADGE
   ========================================================================== */
function updateLayerCountBadge() {
    const checked = document.querySelectorAll('#sidebar input[type="checkbox"]:checked').length;
    const badge   = document.getElementById('layer-count-badge');
    if (badge) badge.textContent = checked;
}

/* ==========================================================================
   🎛  HEADER BUTTONS
   ========================================================================== */
const sidebar    = document.getElementById('sidebar');
const statsPanel = document.getElementById('stats-panel');
const btnLayers  = document.getElementById('btn-layers');
const btnStats   = document.getElementById('btn-stats');

btnLayers.addEventListener('click', () => {
    sidebar.classList.toggle('closed');
    btnLayers.classList.toggle('active', !sidebar.classList.contains('closed'));
    setTimeout(() => map.resize(), 290);
});

btnStats.addEventListener('click', () => {
    statsPanel.classList.toggle('closed');
    btnStats.classList.toggle('active', !statsPanel.classList.contains('closed'));
    setTimeout(() => map.resize(), 290);
});

document.getElementById('btn-reset').addEventListener('click', () => {
    map.flyTo({ center: MAP_CENTER, zoom: MAP_ZOOM, duration: 1000 });
    document.querySelectorAll('#sidebar input[type="checkbox"]').forEach(cb => {
        const def = cb.defaultChecked;
        if (cb.checked !== def) { cb.checked = def; cb.dispatchEvent(new Event('change')); }
    });
    /* Reset all per-layer paint controls to default */
    document.querySelectorAll('.preset-btn[data-preset="reset"]').forEach(btn => btn.click());
    /* Reset all palette selections */
    resetAllPalettes();
    updateLayerCountBadge();
});

/* Zoom to Chiang Mai extent */
document.getElementById('btn-zoom-extent').addEventListener('click', () => {
    map.fitBounds(CM_BOUNDS, { padding: 30, duration: 1000 });
});

/* ==========================================================================
   📡  COORDINATE DISPLAY
   ========================================================================== */
const coordEl = document.getElementById('coord-latlng');
const zoomEl  = document.getElementById('coord-zoom-lbl');

map.on('mousemove', (e) => {
    if (coordEl) coordEl.textContent = `${e.lngLat.lat.toFixed(5)}° N,  ${e.lngLat.lng.toFixed(5)}° E`;
});
map.on('zoom', () => {
    if (zoomEl) zoomEl.textContent = `Zoom: ${map.getZoom().toFixed(1)}`;
});
map.on('mouseleave', () => {
    if (coordEl) coordEl.textContent = 'เลื่อน cursor บนแผนที่';
});

/* ==========================================================================
   🔍  GEOCODING SEARCH
   ========================================================================== */
const geocodeInput   = document.getElementById('geocode-input');
const geocodeResults = document.getElementById('geocode-results');
const searchClear    = document.getElementById('search-clear');
let geocodeTimer     = null;

geocodeInput.addEventListener('input', () => {
    const q = geocodeInput.value.trim();
    searchClear.classList.toggle('hidden', q.length === 0);
    clearTimeout(geocodeTimer);
    if (q.length < 2) { hideResults(); return; }
    geocodeTimer = setTimeout(() => fetchGeocode(q), 320);
});

searchClear.addEventListener('click', () => {
    geocodeInput.value = '';
    searchClear.classList.add('hidden');
    hideResults();
    geocodeInput.focus();
});

geocodeInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { geocodeInput.value = ''; searchClear.classList.add('hidden'); hideResults(); }
});

async function fetchGeocode(query) {
    try {
        const url  = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`
            + `?country=th&language=th&proximity=${MAP_CENTER.join(',')}&limit=6&access_token=${MAPBOX_TOKEN}`;
        const data = await (await fetch(url)).json();
        showResults(data.features || []);
    } catch { hideResults(); }
}

function showResults(features) {
    geocodeResults.innerHTML = '';
    if (!features.length) { hideResults(); return; }
    features.forEach(f => {
        const li  = document.createElement('li');
        const ctx = (f.context || []).map(c => c.text).join(', ');
        li.innerHTML = `<div>${f.text}</div><div class="result-place">${ctx || f.place_name}</div>`;
        li.addEventListener('click', () => {
            map.flyTo({ center: f.center, zoom: 12, duration: 1000 });
            geocodeInput.value = f.text;
            searchClear.classList.remove('hidden');
            hideResults();
        });
        geocodeResults.appendChild(li);
    });
    geocodeResults.classList.remove('hidden');
}

function hideResults() { geocodeResults.classList.add('hidden'); geocodeResults.innerHTML = ''; }

/* ==========================================================================
   🗺  MAP LEGEND — dynamic based on active layers
   ========================================================================== */
const LEGEND_DEFS = {
    lyr_agb_2019:      { label:'AGB 2562 (Mg/ha)',     type:'gradient', stops:[{c:'#f7fcf5',v:'31'},{c:'#a1d99b',v:'100'},{c:'#41ab5d',v:'170'},{c:'#00441b',v:'237'}] },
    lyr_agb_2023:      { label:'AGB 2566 (Mg/ha)',     type:'gradient', stops:[{c:'#f7fcf5',v:'31'},{c:'#a1d99b',v:'100'},{c:'#41ab5d',v:'170'},{c:'#00441b',v:'237'}] },
    lyr_co2_2019:      { label:'CO₂ 2562 (Mg/ha)',     type:'gradient', stops:[{c:'#fff7ec',v:'50'},{c:'#fdd49e',v:'200'},{c:'#ef6548',v:'400'},{c:'#7f0000',v:'600+'}] },
    lyr_co2_2023:      { label:'CO₂ 2566 (Mg/ha)',     type:'gradient', stops:[{c:'#fff7ec',v:'50'},{c:'#fdd49e',v:'200'},{c:'#ef6548',v:'400'},{c:'#7f0000',v:'600+'}] },
    lyr_forest_2019:   { label:'ป่าไม้ 2562',           type:'class',    classes:[{c:'#74c476',l:'ป่าผลัดใบ'},{c:'#006d2c',l:'ป่าไม่ผลัดใบ'}] },
    lyr_forest_2023:   { label:'ป่าไม้ 2566',           type:'class',    classes:[{c:'#74c476',l:'ป่าผลัดใบ'},{c:'#006d2c',l:'ป่าไม่ผลัดใบ'}] },
    lyr_change_detect: { label:'การเปลี่ยนแปลงป่าไม้',  type:'class',    classes:[{c:'#d73027',l:'ป่าลดลง'},{c:'#4dac26',l:'ป่าเพิ่มขึ้น'},{c:'#bababa',l:'ไม่เปลี่ยนแปลง'}] },
    lyr_forest_fill:   { label:'ขอบเขตป่าไม้ (Vector)', type:'class',    classes:[{c:'#41ab5d',l:'พื้นที่ป่าไม้'}] }
};

function updateLegend() {
    const body      = document.getElementById('legend-body');
    const container = document.getElementById('map-legend');
    if (!body || !container) return;

    body.innerHTML = '';
    let count = 0;

    Object.entries(LEGEND_DEFS).forEach(([id, def]) => {
        const cb = document.querySelector(`input[data-layer="${id}"], input[data-layer*="${id}"]`);
        if (!cb || !cb.checked) return;
        count++;

        const item = document.createElement('div');
        item.className = 'legend-item';
        let html = `<div class="legend-lyr-name">${def.label}</div>`;

        if (def.type === 'gradient') {
            const grad = def.stops.map(s => s.c).join(',');
            html += `<div class="legend-grad" style="background:linear-gradient(to right,${grad});"></div>`;
            html += `<div class="legend-grad-vals">${def.stops.map(s => `<span>${s.v}</span>`).join('')}</div>`;
        } else {
            html += def.classes.map(c =>
                `<div class="legend-class"><span class="legend-class-dot" style="background:${c.c};"></span>${c.l}</div>`
            ).join('');
        }

        item.innerHTML = html;
        body.appendChild(item);
    });

    container.style.display = count > 0 ? 'block' : 'none';
}

document.getElementById('legend-toggle-btn').addEventListener('click', () => {
    document.getElementById('legend-body').classList.toggle('hidden');
    document.getElementById('legend-toggle-btn').classList.toggle('collapsed');
});

/* ==========================================================================
   📊  STATS PANEL — Tabs
   ========================================================================== */
document.querySelectorAll('.stab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.stab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.stab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('stab-' + btn.dataset.stab).classList.add('active');
        initCharts();
    });
});

/* ==========================================================================
   📊  CHART DATA
   ========================================================================== */
const DASH = {
    /* ── ข้อมูลตามประเภทป่าไม้ (AGB_CO2_by_ForestType.csv) ────────────────── */
    forestType: {
        labels:         ['ป่าผลัดใบ (Deciduous)', 'ป่าไม่ผลัดใบ (Evergreen)'],
        forestArea2019: [762411,  530684],   // ha
        forestArea2023: [835279,  544686],   // ha
        meanAGB2019:    [145.39,  205.67],   // Mg/ha
        meanAGB2023:    [152.67,  208.38]    // Mg/ha
    },

    /* ── Top-10 อำเภอตามพื้นที่ป่าปี 2566 (ChiangMai_Stats_by_District.csv) ─ */
    districts: {
        labels:         ['แม่แจ่ม','อมก๋อย','เชียงดาว','แม่แตง','ฮอด','พร้าว','สะเมิง','วังเหนือ','ดอยเต่า','ดอยสะเก็ด'],
        forestArea2019: [190444, 199241, 143835, 114530,  91879,  98159,  89528, 63086, 47652, 54286],  // ha
        forestArea2023: [219465, 217545, 156175, 123075, 105358, 101029,  93910, 65793, 53462, 52898],  // ha
        meanAGB2019:    [187.47, 180.42, 171.56, 171.51, 123.54, 180.41, 181.80, 194.10, 100.38, 155.63],
        meanAGB2023:    [193.40, 182.74, 174.73, 174.23, 132.82, 180.24, 186.21, 201.10, 111.12, 162.80]
    },

    /* ── Feature Importance — Classifier ป่าไม้ (Feature_Importance_Classifier.csv) */
    featureImportanceClassifier: {
        labels: ['elevation','slope','VH','VV','B2','B3','B8','B4','EVI','DVI','SAVI','TVI','NDVI','IPVI','RVI'],
        values: [8.67, 8.11, 7.49, 7.45, 7.45, 7.16, 6.54, 6.47, 6.35, 6.26, 6.06, 5.62, 5.56, 5.44, 5.36]
    },

    /* ── Feature Importance — AGB Regressor (Feature_Importance_Regressor.csv) */
    featureImportanceRegressor: {
        labels: ['elevation','B4','IPVI','slope','B2','TVI','RVI','B3','VH','NDVI','VV','EVI','B8','SAVI','DVI'],
        values: [10.94, 7.92, 7.38, 7.28, 7.02, 6.90, 6.47, 6.44, 6.42, 6.40, 6.28, 5.37, 5.26, 5.17, 4.74]
    }
};

const C = {
    g1: 'rgba(74,222,128,0.70)', g2: 'rgba(21,128,61,0.85)',
    b1: 'rgba(33,102,172,0.65)', b2: 'rgba(5,48,97,0.85)',
    r:  'rgba(234,88,12,0.75)'
};

let chartsReady = false;

function initCharts() {
    if (chartsReady) return;
    chartsReady = true;
    const legend = { labels: { font: { size: 10 }, boxWidth: 11, padding: 8 } };

    new Chart(document.getElementById('chartCoverage'), {
        type: 'doughnut',
        data: {
            labels: ['ป่าไม้ (74.7%)', 'ที่ดินอื่น (25.3%)'],
            datasets: [{ data: [74.7, 25.3], backgroundColor: ['#16a34a', '#e5e7eb'], borderWidth: 0 }]
        },
        options: { responsive:false, cutout:'72%', plugins:{ legend:{display:false} }, animation:{duration:1200,easing:'easeOutQuart'} }
    });

    animateCounter(document.getElementById('pct-counter'), 74.7, 1300);

    new Chart(document.getElementById('chartForestType'), {
        data: {
            labels: DASH.forestType.labels,
            datasets: [
                { type:'bar',  label:'พื้นที่ป่า 2562 (ha)', data:DASH.forestType.forestArea2019, backgroundColor:C.g1, yAxisID:'yA' },
                { type:'bar',  label:'พื้นที่ป่า 2566 (ha)', data:DASH.forestType.forestArea2023, backgroundColor:C.g2, yAxisID:'yA' },
                { type:'line', label:'AGB 2562 (Mg/ha)', data:DASH.forestType.meanAGB2019, borderColor:C.b1, backgroundColor:C.b1, pointRadius:4, yAxisID:'yB', tension:0.3 },
                { type:'line', label:'AGB 2566 (Mg/ha)', data:DASH.forestType.meanAGB2023, borderColor:C.b2, backgroundColor:C.b2, pointRadius:4, yAxisID:'yB', tension:0.3 }
            ]
        },
        options: { responsive:true, plugins:{legend}, scales:{ yA:{position:'left',title:{display:true,text:'ha',font:{size:9}}}, yB:{position:'right',title:{display:true,text:'Mg/ha',font:{size:9}},grid:{drawOnChartArea:false}} } }
    });

    new Chart(document.getElementById('chartProvDistAGB'), {
        type:'bar',
        data:{ labels:DASH.districts.labels, datasets:[{label:'AGB 2566 (Mg/ha)',data:DASH.districts.meanAGB2023,backgroundColor:C.g2}] },
        options:{ indexAxis:'y', responsive:true, plugins:{legend:{display:false}}, scales:{x:{suggestedMin:100,title:{display:true,text:'Mg/ha',font:{size:9}}},y:{ticks:{font:{size:9}}}}}
    });

    new Chart(document.getElementById('chartDistrictForest'), {
        type:'bar',
        data:{ labels:DASH.districts.labels, datasets:[{label:'2562 (ha)',data:DASH.districts.forestArea2019,backgroundColor:C.g1},{label:'2566 (ha)',data:DASH.districts.forestArea2023,backgroundColor:C.g2}] },
        options:{ responsive:true, plugins:{legend}, scales:{y:{title:{display:true,text:'ha',font:{size:9}}},x:{ticks:{font:{size:9}}}}}
    });

    new Chart(document.getElementById('chartDistrictAGB'), {
        type:'bar',
        data:{ labels:DASH.districts.labels, datasets:[{label:'AGB 2562 (Mg/ha)',data:DASH.districts.meanAGB2019,backgroundColor:C.b1},{label:'AGB 2566 (Mg/ha)',data:DASH.districts.meanAGB2023,backgroundColor:C.b2}] },
        options:{ responsive:true, plugins:{legend}, scales:{y:{suggestedMin:100,title:{display:true,text:'Mg/ha',font:{size:9}}},x:{ticks:{font:{size:9}}}}}
    });

    /* Feature Importance — Classifier (ป่าผลัดใบ / ป่าไม่ผลัดใบ) */
    new Chart(document.getElementById('chartFeatureImportance'), {
        type:'bar',
        data:{
            labels: DASH.featureImportanceClassifier.labels,
            datasets:[{
                label:'ความสำคัญ (%)',
                data: DASH.featureImportanceClassifier.values,
                backgroundColor: DASH.featureImportanceClassifier.labels.map((_,i)=>i<2?C.r:C.b1)
            }]
        },
        options:{ indexAxis:'y', responsive:true, plugins:{legend:{display:false}}, scales:{x:{suggestedMin:0,suggestedMax:12,title:{display:true,text:'%',font:{size:9}}},y:{ticks:{font:{size:9}}}}}
    });

    /* Feature Importance — AGB Regressor (Random Forest) */
    new Chart(document.getElementById('chartFeatureImportanceRegressor'), {
        type:'bar',
        data:{
            labels: DASH.featureImportanceRegressor.labels,
            datasets:[{
                label:'ความสำคัญ (%)',
                data: DASH.featureImportanceRegressor.values,
                backgroundColor: DASH.featureImportanceRegressor.labels.map((_,i)=>i<2?C.r:C.b1)
            }]
        },
        options:{ indexAxis:'y', responsive:true, plugins:{legend:{display:false}}, scales:{x:{suggestedMin:0,suggestedMax:14,title:{display:true,text:'%',font:{size:9}}},y:{ticks:{font:{size:9}}}}}
    });
}

/* ==========================================================================
   🔢  ANIMATED COUNTER
   ========================================================================== */
function animateCounter(el, target, duration = 1200) {
    if (!el) return;
    const t0 = performance.now();
    function tick(now) {
        const t = Math.min((now - t0) / duration, 1);
        el.textContent = (target * (1 - Math.pow(1 - t, 3))).toFixed(1) + '%';
        if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

window.addEventListener('load', () => setTimeout(initCharts, 700));
