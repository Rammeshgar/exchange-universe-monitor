// ECharts layouts adapted from PC-test-automation/dashboard/index.html.
const stabilityMatrix = (() => {
    const target = document.getElementById('historyChart');
    const narrow = () => target.clientWidth < 580;
    const themeColor = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const displayTime = new Intl.DateTimeFormat('en-US', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        hourCycle: 'h23', timeZone: 'Europe/Budapest'
    });
    const tickTime = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Budapest'
    });
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let chart;
    let selectRun;
    let reportZoom;
    let webglSupported;
    let floor;
    let visibleMode;
    let press;

    function canRender3D() {
        if (webglSupported === undefined) {
            const test = document.createElement('canvas');
            const context = test.getContext('webgl') || test.getContext('experimental-webgl');
            webglSupported = Boolean(context);
            context?.getExtension('WEBGL_lose_context')?.loseContext();
        }
        return webglSupported;
    }

    function tooltip(showStatus, timeIndex = 0) {
        return {
            trigger: 'item',
            renderMode: 'richText',
            backgroundColor: themeColor('--surface'),
            borderColor: themeColor('--strong-line'),
            textStyle: { color: themeColor('--text'), fontFamily: 'Inter' },
            formatter: point => {
                const { value, seriesName } = point;
                return displayTime.format(value[timeIndex]) + ' · ' + seriesName + '\n' +
                    showStatus(value) + ' · Select for run details';
            }
        };
    }

    function renderTimeline(lanes, span) {
        const compact = narrow();
        const font = themeColor('--text-muted');
        const gridColor = themeColor('--chart-grid');
        const plotColor = themeColor('--plot');
        const axisLabel = { hideOverlap: true, fontSize: compact ? 10 : 12, formatter: value => tickTime.format(value), color: font, fontWeight: 600 };
        const left = compact ? 43 : 55;
        const right = compact ? 14 : 30;
        const grid = lanes.map((lane, index) => ({
            top: 11 + 29 * index + '%', height: '19%', left, right,
            show: true, borderColor: gridColor, backgroundColor: lane.color + '0b'
        }));
        const xAxisIndices = lanes.map((_, index) => index);

        chart.setOption({
            animation: false,
            tooltip: tooltip(value => value[1] === 1 ? 'PASS' : 'FAIL'),
            grid,
            graphic: lanes.map((lane, index) => ({
                type: 'text', silent: true, left, top: 4.2 + 29 * index + '%',
                style: { text: lane.short, fill: lane.color, font: '700 ' + (compact ? 11 : 13) + 'px Inter' }
            })),
            dataZoom: [
                { type: 'slider', xAxisIndex: xAxisIndices, startValue: span.viewportStart, endValue: span.viewportEnd, left, right, bottom: 9, height: 13, borderColor: gridColor, textStyle: { color: font }, fillerColor: themeColor('--chart-selection') },
                { type: 'inside', xAxisIndex: xAxisIndices, zoomOnMouseWheel: true }
            ],
            xAxis: lanes.map((_, index) => ({
                type: 'time', gridIndex: index, min: span.start, max: span.end, show: index === lanes.length - 1,
                splitNumber: compact ? 3 : 6, minInterval: 5 * 60_000, axisLabel,
                splitLine: { show: true, lineStyle: { color: gridColor, type: 'dashed' } }
            })),
            yAxis: lanes.map((_, index) => ({
                type: 'value', gridIndex: index, min: 0, max: 1, interval: 1,
                axisLine: { show: false }, axisTick: { show: false },
                axisLabel: { formatter: value => value === 1 ? 'PASS' : 'FAIL', color: font, fontWeight: 'bold', fontSize: compact ? 10 : 12 },
                splitLine: { lineStyle: { color: gridColor } }
            })),
            series: lanes.map((lane, index) => ({
                name: lane.short, type: 'line', xAxisIndex: index, yAxisIndex: index,
                data: lane.points.map(point => [point.time, point.pass, point.id]),
                step: 'end', symbol: 'circle', symbolSize: compact ? 8 : 11, showSymbol: true,
                itemStyle: { color: lane.color, borderColor: plotColor, borderWidth: 2 },
                lineStyle: { color: lane.color, width: 2 },
                areaStyle: { origin: 'start', color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: lane.color + '29' }, { offset: 1, color: lane.color + '03' }]) }
            }))
        }, { notMerge: true });
    }

    function renderWebGL(lanes, span) {
        const gridColor = themeColor('--chart-grid-3d');
        const gridLines = { lineStyle: { color: gridColor } };
        const noPointer = { show: false };
        const duration = span.viewportEnd - span.viewportStart;
        const points = lanes.map((lane, index) => lane.points.map(point => [
            (point.time - span.viewportStart) / duration, (index + 1) * 10, point.pass, point.time, point.id
        ]));
        const symbols = ['circle', 'diamond', 'triangle'];
        const axisText = themeColor('--text-muted');
        const passColor = themeColor('--good');
        const failColor = themeColor('--bad');
        chart.setOption({
            animation: false,
            tooltip: tooltip(value => value[2] === 1 ? 'PASS' : 'FAIL', 3),
            grid3D: {
                boxWidth: 192, boxDepth: 107, boxHeight: 73, environment: 'none',
                axisLine: { lineStyle: { color: axisText } },
                viewControl: { projection: 'perspective', alpha: 20, beta: 30, distance: narrow() ? 349 : 300, rotateMouseButton: 'left', panMouseButton: 'right' },
                light: { main: { intensity: 1.2, shadow: false }, ambient: { intensity: .3 } }
            },
            xAxis3D: {
                type: 'value', min: 0, max: 1, interval: narrow() ? .5 : .25, name: '',
                axisLabel: { formatter: value => tickTime.format(span.viewportStart + value * duration), color: axisText, margin: 9 },
                splitLine: gridLines, axisPointer: noPointer
            },
            yAxis3D: {
                type: 'value', min: 0, max: 40, interval: 10, name: '',
                axisLabel: { formatter: value => lanes[value / 10 - 1]?.short || '', color: axisText },
                splitLine: gridLines, axisPointer: noPointer
            },
            zAxis3D: {
                type: 'value', min: 0, max: 1, interval: 1, name: '',
                axisLabel: { formatter: value => value === 1 ? 'PASS' : 'FAIL', color: axisText },
                splitLine: gridLines, axisPointer: noPointer
            },
            series: [
                ...lanes.map((lane, index) => ({
                    name: lane.short, type: 'line3D', data: points[index], silent: true,
                    encode: { x: 0, y: 1, z: 2 }, lineStyle: { width: 2, color: lane.color, opacity: .55 }
                })),
                ...lanes.map((lane, index) => ({
                    name: lane.short, type: 'scatter3D', data: points[index],
                    encode: { x: 0, y: 1, z: 2 }, symbol: symbols[index], symbolSize: 15,
                    itemStyle: { opacity: 1, color: item => item.value[2] === 1 ? passColor : failColor }
                }))
            ]
        }, { notMerge: true });
    }

    function transformPoint(matrix, [x, y, z, w]) {
        return [
            matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12] * w,
            matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13] * w,
            matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14] * w,
            matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15] * w
        ];
    }

    function pickWebGLRun(event) {
        const rect = target.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const chartHeight = chart.getHeight();
        const hitRadius = event.pointerType === 'touch' ? 18 : 12;
        let closest;

        for (const series of chart.getModel().getSeriesByType('scatter3D')) {
            const coordinates = series.coordinateSystem;
            const { camera, viewport } = coordinates.viewGL;
            const data = series.getData();

            for (let index = 0; index < data.count(); index++) {
                const value = data.getRawDataItem(index);
                const id = value?.at(-1);
                if (typeof id !== 'string') continue;
                const world = coordinates.dataToPoint(value);
                const view = transformPoint(camera.viewMatrix.array, [...world, 1]);
                const [cx, cy, cz, cw] = transformPoint(camera.projectionMatrix.array, view);
                if (!(cw > 0) || Math.abs(cx) > cw || Math.abs(cy) > cw || Math.abs(cz) > cw) continue;

                const px = viewport.x + (cx / cw + 1) * viewport.width / 2;
                const py = chartHeight - viewport.y - (cy / cw + 1) * viewport.height / 2;
                const distance = Math.hypot(px - x, py - y);
                const depth = cz / cw;
                if (distance <= hitRadius && (!closest || distance < closest.distance ||
                    (distance === closest.distance && depth < closest.depth))) {
                    closest = { id, distance, depth };
                }
            }
        }
        return closest?.id;
    }

    // ECharts GL can miss the point hit entirely. Use the displayed camera and markers,
    // and keep orbit/pan gestures separate from a stationary pointer release.
    target.addEventListener('pointerdown', event => {
        if (visibleMode !== '3d' || !event.isPrimary || event.button !== 0) return;
        press = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }, true);
    function clearDrag(event) {
        if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) press = null;
    }
    target.addEventListener('pointermove', clearDrag, true);
    target.addEventListener('pointercancel', () => { press = null; }, true);
    target.addEventListener('pointerleave', () => { press = null; });
    target.addEventListener('pointerup', event => {
        clearDrag(event);
        const isClick = visibleMode === '3d' && press?.id === event.pointerId;
        press = null;
        if (!isClick) return;
        const id = pickWebGLRun(event);
        if (id) selectRun(id);
    }, true);

    function render(mode, lanes, span, onSelect, onZoom) {
        visibleMode = mode;
        press = null;
        selectRun = onSelect;
        reportZoom = mode === '2d' ? onZoom : null;
        if (mode === '3d' && !canRender3D()) return false;
        if (!chart) {
            chart = echarts.init(target, null, { devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2) });
            chart.on('click', point => {
                if (visibleMode === '2d' && typeof point.value?.at(-1) === 'string') selectRun(point.value.at(-1));
            });
            chart.on('datazoom', () => {
                const zoom = chart.getModel().getComponent('dataZoom');
                const span = zoom?.getValueRange('x', 0);
                if (span?.every(Number.isFinite)) reportZoom?.(...span);
            });
            new ResizeObserver(() => {
                if (target.clientWidth && target.clientHeight) chart.resize();
            }).observe(target);
        }
        chart.resize();
        if (mode === '3d') renderWebGL(lanes, span);
        else renderTimeline(lanes, span);
        return true;
    }

    function startFloor() {
        const canvas = document.getElementById('bg-canvas');
        const wide = matchMedia('(min-width: 1001px)');
        if (!wide.matches || !window.THREE || !canRender3D()) return;
        try {
            const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
            const scene = new THREE.Scene();
            const camera = new THREE.PerspectiveCamera(60, 1, .1, 1000);
            const geometry = new THREE.PlaneGeometry(300, 150, 60, 30);
            const material = new THREE.MeshBasicMaterial({ color: 0x0ea5e9, wireframe: true, transparent: true });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.rotation.x = -Math.PI / 2.2;
            mesh.position.set(0, -25, -30);
            scene.add(mesh);
            scene.fog = new THREE.FogExp2(themeColor('--bg-color'), .012);
            floor = () => {
                material.opacity = .26;
                scene.fog.color.set(themeColor('--bg-color'));
                renderer.render(scene, camera);
            };
            function resize() {
                if (!wide.matches) return;
                camera.aspect = innerWidth / innerHeight;
                camera.updateProjectionMatrix();
                renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
                renderer.setSize(innerWidth, innerHeight, false);
                floor();
            }
            window.addEventListener('resize', resize);
            resize();
            let lastFrame = 0;
            function frame(timestamp) {
                if (document.hidden || motion.matches || !wide.matches) return;
                if (timestamp - lastFrame >= 33) {
                    const position = geometry.attributes.position;
                    const time = timestamp * .0003;
                    for (let index = 0; index < position.count; index++) {
                        position.setZ(index, Math.sin(position.getX(index) * .05 + time) * 6 + Math.cos(position.getY(index) * .05 + time) * 6);
                    }
                    position.needsUpdate = true;
                    renderer.render(scene, camera);
                    lastFrame = timestamp;
                }
                animation = requestAnimationFrame(frame);
            }
            let animation;
            function resume() {
                cancelAnimationFrame(animation);
                if (!document.hidden && !motion.matches && wide.matches) animation = requestAnimationFrame(frame);
            }
            document.addEventListener('visibilitychange', resume);
            wide.addEventListener('change', resume);
            motion.addEventListener('change', resume);
            resume();
        } catch {
            canvas.hidden = true;
        }
    }

    function clear() {
        visibleMode = null;
        press = null;
        chart?.clear();
    }
    return { render, clear, startFloor, updateFloor: () => floor?.() };
})();
