// ECharts layouts adapted from PC-test-automation/dashboard/index.html.
const stabilityMatrix = (() => {
    const target = document.getElementById('historyChart');
    const narrow = () => target.clientWidth < 580;
    const isDark = () => document.documentElement.dataset.theme === 'dark';
    const displayTime = new Intl.DateTimeFormat('en-US', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        hourCycle: 'h23', timeZone: 'Europe/Budapest'
    });
    const tickTime = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Budapest'
    });
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const passColor = '#10b981';
    const failColor = '#ef4444';
    let chart;
    let selectRun;
    let reportZoom;
    let webglSupported;
    let floor;

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
            backgroundColor: isDark() ? '#101829' : '#f8fafc',
            borderColor: '#0e6693',
            textStyle: { color: isDark() ? '#f8fafc' : '#0f172a', fontFamily: 'Inter' },
            formatter: point => {
                const { value, seriesName } = point;
                return displayTime.format(value[timeIndex]) + ' · ' + seriesName + '\n' +
                    showStatus(value) + ' · Select for run details';
            }
        };
    }

    function renderTimeline(lanes, span) {
        const compact = narrow();
        const font = isDark() ? '#94a3b8' : '#334155';
        const gridColor = isDark() ? 'rgba(14,165,233,.14)' : 'rgba(14,165,233,.23)';
        const axisLabel = { hideOverlap: true, fontSize: compact ? 10 : 12, formatter: value => tickTime.format(value), color: '#f59e0b', fontWeight: 'bold' };
        const left = compact ? 57 : 80;
        const right = compact ? 14 : 30;
        const grid = lanes.map((_, index) => ({ top: 11.5 + 30 * index + '%', height: '17.3%', left, right }));
        const xAxisIndices = lanes.map((_, index) => index);

        chart.setOption({
            animation: false,
            tooltip: tooltip(value => value[1] === 1 ? 'PASS' : 'FAIL'),
            grid,
            dataZoom: [
                { type: 'slider', xAxisIndex: xAxisIndices, startValue: span.viewportStart, endValue: span.end, left, right, bottom: 4, height: 17, borderColor: gridColor, textStyle: { color: font }, fillerColor: 'rgba(14,165,233,.24)' },
                { type: 'inside', xAxisIndex: xAxisIndices, zoomOnMouseWheel: true }
            ],
            xAxis: lanes.map((_, index) => ({
                type: 'time', gridIndex: index, min: span.start, max: span.end, show: index === lanes.length - 1,
                splitNumber: compact ? 3 : 6, minInterval: 5 * 60_000, axisLabel,
                splitLine: { show: true, lineStyle: { color: gridColor, type: 'dashed' } }
            })),
            yAxis: lanes.map((lane, index) => ({
                type: 'value', gridIndex: index, min: 0, max: 1, interval: 1,
                axisLine: { show: false }, axisTick: { show: false },
                axisLabel: { formatter: value => value === 1 ? 'PASS' : 'FAIL', color: font, fontWeight: 'bold', fontSize: compact ? 10 : 12 },
                splitLine: { lineStyle: { color: gridColor } },
                name: lane.short, nameLocation: 'middle', nameGap: compact ? 40 : 58,
                nameTextStyle: { color: lane.color, fontSize: compact ? 11 : 13, fontWeight: 'bold' }
            })),
            series: lanes.map((lane, index) => ({
                name: lane.short, type: 'line', xAxisIndex: index, yAxisIndex: index,
                data: lane.points.map(point => [point.time, point.pass, point.id]),
                step: 'end', symbol: 'circle', symbolSize: compact ? 8 : 11, showSymbol: true,
                itemStyle: { color: lane.color, borderColor: isDark() ? '#020617' : '#fff', borderWidth: 2 },
                lineStyle: { color: lane.color, width: 3, shadowColor: lane.color, shadowBlur: 8 },
                areaStyle: { origin: 'start', color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: lane.color + '46' }, { offset: 1, color: lane.color + '03' }]) }
            }))
        }, { notMerge: true });
    }

    function renderWebGL(lanes, span) {
        const gridColor = isDark() ? 'rgba(14,165,233,.26)' : 'rgba(15,23,42,.25)';
        const gridLines = { lineStyle: { color: gridColor } };
        const noPointer = { show: false };
        const duration = span.end - span.viewportStart;
        const points = lanes.map((lane, index) => lane.points.map(point => [
            (point.time - span.viewportStart) / duration, (index + 1) * 10, point.pass, point.time, point.id
        ]));
        const symbols = ['circle', 'diamond', 'triangle'];
        const axisText = isDark() ? '#a7b9d4' : '#334155';
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
                axisLabel: { formatter: value => tickTime.format(span.viewportStart + value * duration), color: '#f59e0b', margin: 9 },
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

    function render(mode, lanes, span, onSelect, onZoom) {
        selectRun = onSelect;
        reportZoom = mode === '2d' ? onZoom : null;
        if (mode === '3d' && !canRender3D()) return false;
        if (!chart) {
            chart = echarts.init(target, null, { devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2) });
            chart.on('click', point => {
                if (typeof point.value?.at(-1) === 'string') selectRun(point.value.at(-1));
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
            scene.fog = new THREE.FogExp2(0x020617, .012);
            floor = () => {
                material.opacity = isDark() ? .33 : .24;
                scene.fog.color.setHex(isDark() ? 0x020617 : 0xcddbe8);
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

    function clear() { chart?.clear(); }
    return { render, clear, startFloor, updateFloor: () => floor?.() };
})();
