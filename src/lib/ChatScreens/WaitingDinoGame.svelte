<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { language } from 'src/lang';

    type GameState = 'idle' | 'running' | 'frozen' | 'over';

    let canvas: HTMLCanvasElement | undefined = $state();
    let container: HTMLDivElement | undefined = $state();
    let gameState: GameState = $state('idle');
    let score = $state(0);
    let highScore = $state(0);
    let isNewHighScore = $state(false);
    let frozenMessage = $state('');

    const HIGHSCORE_KEY = 'risu-dino-highscore';
    const CANVAS_H = 120;

    // ---- game constants (logical px per second) ----
    const GROUND_Y_RATIO = 0.86;
    const GRAVITY = 2400;
    const JUMP_VELOCITY = 830; // upward, dinoY is height above ground
    const DUCK_GRAVITY = 4200;
    const BASE_SPEED = 320;
    const MAX_SPEED = 700;
    const SPEED_RAMP = 26; // speed gain per 100 points
    const NIGHT_INTERVAL = 400;
    const BIRD_UNLOCK = 200;
    const DINO_X = 18;
    const DINO_H = 44;
    const DINO_DUCK_H = 24;

    // ---- entity state (non-reactive, mutated in rAF loop) ----
    let rafId = 0;
    let lastTime = 0;
    let dinoY = 0; // height above ground (>= 0)
    let dinoVY = 0;
    let ducking = false;
    let speed = BASE_SPEED;
    let obstacles: { type: 'cactus' | 'bird'; x: number; w: number; h: number; y: number }[] = [];
    let clouds: { x: number; y: number; s: number }[] = [];
    let spawnTimer = 0;
    let cloudTimer = 0;
    let scoreInternal = 0;
    let birdFrameTimer = 0;
    let distance = 0;

    // ---- colors (read once + on theme change) ----
    let themeColors = $state({ fg: '#f5f5f5', fgDim: '#64748b', bg: '#282a36' });
    let themeObserver: MutationObserver | undefined;

    function readTheme() {
        try {
            const style = getComputedStyle(document.documentElement);
            const pick = (names: string[], fallback: string): string => {
                for (const name of names) {
                    const value = style.getPropertyValue(name).trim();
                    if (value) return value.startsWith('#') ? value : normalizeCssColor(value, fallback);
                }
                return fallback;
            };
            themeColors = {
                fg: pick(['--risu-theme-textcolor', '--color-textcolor'], themeColors.fg),
                fgDim: pick(['--risu-theme-textcolor2', '--color-textcolor2'], themeColors.fgDim),
                bg: pick(['--risu-theme-bgcolor', '--color-bgcolor'], themeColors.bg),
            };
        } catch {
            // keep defaults
        }
    }

    /** CSS variables can hold rgb()/oklch() — convert anything unusable to the fallback. */
    function normalizeCssColor(value: string, fallback: string): string {
        if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
        const probe = document.createElement('canvas').getContext('2d');
        if (!probe) return fallback;
        probe.fillStyle = '#000';
        probe.fillStyle = value;
        const applied = probe.fillStyle;
        if (typeof applied === 'string' && applied.startsWith('#')) return applied;
        return fallback;
    }

    function nightAmount(): number {
        // Instant switch like the original Chrome Dino — a smooth fade would pass
        // through a low-contrast midpoint (fg and bg converge to mid-gray)
        return Math.floor(scoreInternal / NIGHT_INTERVAL) % 2 === 1 ? 1 : 0;
    }

    function hexToRgb(hex: string): [number, number, number] | null {
        let m = hex.replace('#', '').trim();
        // also accept rgb()/rgba() — invertLum() and lerpColor() emit this format
        if (/^rgba?\(/i.test(m)) {
            const parts = m.match(/[\d.]+/g);
            if (!parts || parts.length < 3) return null;
            return [Math.round(+parts[0]), Math.round(+parts[1]), Math.round(+parts[2])];
        }
        if (/^[0-9a-f]{3}$/i.test(m)) {
            return [parseInt(m[0] + m[0], 16), parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16)];
        }
        if (/^[0-9a-f]{6}$/i.test(m)) {
            return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
        }
        return null;
    }

    function lerpColor(a: string, b: string, t: number): string {
        if (t <= 0) return a;
        if (t >= 1) return b;
        const pa = hexToRgb(a);
        const pb = hexToRgb(b);
        if (!pa || !pb) return t < 0.5 ? a : b;
        return `rgb(${Math.round(pa[0] + (pb[0] - pa[0]) * t)},${Math.round(pa[1] + (pb[1] - pa[1]) * t)},${Math.round(pa[2] + (pb[2] - pa[2]) * t)})`;
    }

    function invertLum(color: string): string {
        const rgb = hexToRgb(color);
        if (!rgb) return color;
        return `rgb(${255 - rgb[0]},${255 - rgb[1]},${255 - rgb[2]})`;
    }

    /** Perceptual-ish distance between two colors; both must be hex. */
    function colorDistance(a: string, b: string): number {
        const pa = hexToRgb(a);
        const pb = hexToRgb(b);
        if (!pa || !pb) return 999; // unknown colors — assume fine
        const lumA = 0.299 * pa[0] + 0.587 * pa[1] + 0.114 * pa[2];
        const lumB = 0.299 * pb[0] + 0.587 * pb[1] + 0.114 * pb[2];
        return Math.abs(lumA - lumB);
    }

    // ---- canvas sizing ----
    let cssWidth = 0;
    let dpr = 1;
    let resizeObserver: ResizeObserver | undefined;

    function resizeCanvas() {
        if (!canvas || !container) return;
        const width = container.clientWidth;
        if (width <= 0 || width === cssWidth) return;
        cssWidth = width;
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(cssWidth * dpr);
        canvas.height = Math.floor(CANVAS_H * dpr);
        if (gameState !== 'running') draw();
    }

    // ---- input ----
    function activeElementIsTypingTarget(): boolean {
        const el = document.activeElement;
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
    }

    function startJump() {
        if (gameState === 'idle' || gameState === 'over') {
            startGame();
            return;
        }
        if (gameState !== 'running') return;
        if (dinoY <= 0) dinoVY = JUMP_VELOCITY;
    }

    function setDuck(value: boolean) {
        if (gameState !== 'running') {
            ducking = false;
            return;
        }
        ducking = value;
    }

    function handleKeyDown(e: KeyboardEvent) {
        if (gameState === 'frozen' || document.activeElement !== canvas || activeElementIsTypingTarget()) return;
        if (e.key === ' ' || e.key === 'ArrowUp') {
            e.preventDefault();
            startJump();
        } else if (e.key === 'ArrowDown' && gameState === 'running') {
            e.preventDefault();
            setDuck(true);
        }
    }

    function handleKeyUp(e: KeyboardEvent) {
        if (gameState !== 'running' || document.activeElement !== canvas || activeElementIsTypingTarget()) return;
        if (e.key === 'ArrowDown') setDuck(false);
    }

    function focusGame() {
        canvas?.focus();
    }

    function handlePointerDown(e: PointerEvent) {
        e.preventDefault();
        focusGame();
        startJump();
    }

    function handleStartClick() {
        focusGame();
        startJump();
    }

    function handleRestartClick() {
        focusGame();
        startGame();
    }

    // ---- game flow ----
    function startGame() {
        readTheme();
        dinoY = 0;
        dinoVY = 0;
        ducking = false;
        speed = BASE_SPEED;
        obstacles = [];
        clouds = [];
        spawnTimer = 0.5;
        cloudTimer = 1;
        scoreInternal = 0;
        distance = 0;
        birdFrameTimer = 0;
        isNewHighScore = false;
        score = 0;
        frozenMessage = '';
        gameState = 'running';
        lastTime = performance.now();
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(loop);
    }

    function gameOver() {
        gameState = 'over';
        score = Math.floor(scoreInternal);
        if (score > highScore) {
            highScore = score;
            isNewHighScore = true;
            try {
                localStorage.setItem(HIGHSCORE_KEY, String(score));
            } catch {
                // storage unavailable
            }
        }
        cancelAnimationFrame(rafId);
        draw();
    }

    // exported API: parent freezes the game when the AI response arrives
    export function freezeGame(message?: string) {
        if (gameState === 'running') {
            cancelAnimationFrame(rafId);
            gameState = 'frozen';
            score = Math.floor(scoreInternal);
            frozenMessage = message ?? '';
            draw();
        } else if (gameState === 'idle') {
            gameState = 'frozen';
            frozenMessage = message ?? '';
        }
    }

    // exported API: a new generation started — offer a fresh run from the frozen state
    export function resetGame() {
        if (gameState !== 'frozen') return;
        cancelAnimationFrame(rafId);
        gameState = 'idle';
        dinoY = 0;
        dinoVY = 0;
        ducking = false;
        obstacles = [];
        clouds = [];
        scoreInternal = 0;
        distance = 0;
        score = 0;
        frozenMessage = '';
        draw();
    }

    // ---- spawning ----
    function spawnObstacle() {
        const canBird = scoreInternal >= BIRD_UNLOCK;
        if (canBird && Math.random() < 0.3) {
            // flight heights above ground: low (jump), mid (jump/duck timing), high (run under)
            const heights = [10, 34, 60];
            const y = heights[Math.floor(Math.random() * heights.length)];
            obstacles.push({ type: 'bird', x: cssWidth + 20, w: 30, h: 20, y });
        } else if (Math.random() < 0.25) {
            const count = 2 + Math.floor(Math.random() * 2);
            for (let i = 0; i < count; i++) {
                obstacles.push({
                    type: 'cactus',
                    x: cssWidth + 20 + i * 16,
                    w: 12,
                    h: 24 + Math.random() * 10,
                    y: 0,
                });
            }
        } else {
            const size = Math.random();
            if (size < 0.4) obstacles.push({ type: 'cactus', x: cssWidth + 20, w: 14, h: 26, y: 0 });
            else if (size < 0.8) obstacles.push({ type: 'cactus', x: cssWidth + 20, w: 18, h: 34, y: 0 });
            else obstacles.push({ type: 'cactus', x: cssWidth + 20, w: 26, h: 30, y: 0 });
        }
    }

    function spawnCloud() {
        clouds.push({ x: cssWidth + 30, y: 10 + Math.random() * 28, s: 0.5 + Math.random() * 0.5 });
    }

    // ---- collision (AABB, screen coords, y down) ----
    function checkCollision(ob: { x: number; w: number; h: number; y: number }): boolean {
        const groundY = CANVAS_H * GROUND_Y_RATIO;
        const dH = ducking && dinoY <= 0 ? DINO_DUCK_H : DINO_H;
        const dTop = groundY - dinoY - dH;
        const dX = ducking && dinoY <= 0 ? DINO_X : DINO_X + 2;
        const dW = ducking && dinoY <= 0 ? 40 : 24;
        const obTop = groundY - ob.y - ob.h;
        const pad = 4;
        return (
            dX + pad < ob.x + ob.w - pad &&
            dX + dW - pad > ob.x + pad &&
            dTop + pad < obTop + ob.h &&
            dTop + dH - pad > obTop + pad
        );
    }

    // ---- main loop ----
    function loop(now: number) {
        if (gameState !== 'running') return;
        const dt = Math.min((now - lastTime) / 1000, 0.05);
        lastTime = now;

        speed = Math.min(BASE_SPEED + (scoreInternal / 100) * SPEED_RAMP, MAX_SPEED);

        // dino physics — dinoY is height above ground, velocity is upward-positive
        dinoVY -= (ducking && dinoY > 0 ? DUCK_GRAVITY : GRAVITY) * dt;
        dinoY += dinoVY * dt;
        if (dinoY <= 0) {
            dinoY = 0;
            dinoVY = 0;
        }

        // score by distance
        distance += speed * dt;
        scoreInternal = distance / 10;
        score = Math.floor(scoreInternal);

        // spawns
        spawnTimer -= dt;
        if (spawnTimer <= 0) {
            spawnObstacle();
            const minGap = 0.55;
            const ramp = 1.2 - ((speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED)) * 0.5;
            spawnTimer = Math.max(ramp, minGap) * (0.8 + Math.random() * 0.5);
        }
        cloudTimer -= dt;
        if (cloudTimer <= 0) {
            spawnCloud();
            cloudTimer = 2.5 + Math.random() * 3;
        }

        // movement
        for (const ob of obstacles) ob.x -= speed * dt;
        for (const c of clouds) c.x -= speed * 0.25 * c.s * dt;
        if (obstacles.some((o) => o.type === 'bird')) birdFrameTimer += dt;
        obstacles = obstacles.filter((o) => o.x + o.w > -10);
        clouds = clouds.filter((c) => c.x > -60);

        // collision
        for (const ob of obstacles) {
            if (checkCollision(ob)) {
                gameOver();
                return;
            }
        }

        draw();
        rafId = requestAnimationFrame(loop);
    }

    // ---- drawing ----
    function draw() {
        if (!canvas || cssWidth <= 0) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const W = cssWidth;
        const H = CANVAS_H;
        const groundY = H * GROUND_Y_RATIO;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const night = nightAmount();
        let fg = lerpColor(themeColors.fg, invertLum(themeColors.fg), night);
        let bg = lerpColor(themeColors.bg, invertLum(themeColors.bg), night);
        const fgDim = lerpColor(themeColors.fgDim, invertLum(themeColors.fgDim), night);

        // contrast guard: if fg and bg are too close (bad theme values), force readable colors
        if (colorDistance(fg, bg) < 60) {
            bg = '#1e1f26';
            fg = '#f5f5f5';
        }

        // background
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        // stars at night
        if (night > 0.15) {
            ctx.globalAlpha = night;
            ctx.fillStyle = fgDim;
            for (let i = 0; i < 12; i++) {
                const sx = ((i * 137.5 + distance * 0.08) % (W + 40)) - 20;
                const sy = 10 + ((i * 53) % 40);
                ctx.fillRect(sx, sy, 2, 2);
            }
            ctx.globalAlpha = 1;
        }

        // clouds
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = fgDim;
        for (const c of clouds) {
            const s = c.s;
            ctx.fillRect(c.x, c.y, 26 * s, 8 * s);
            ctx.fillRect(c.x + 8 * s, c.y - 6 * s, 12 * s, 8 * s);
        }
        ctx.globalAlpha = 1;

        // moon at night / sun at day
        ctx.fillStyle = fg;
        if (night > 0.1) {
            ctx.globalAlpha = night;
            ctx.beginPath();
            ctx.arc(W - 42, 24, 10, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = bg;
            ctx.beginPath();
            ctx.arc(W - 37, 21, 9, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        // ground line + scrolling bumps
        ctx.fillStyle = fg;
        ctx.fillRect(0, groundY, W, 2);
        ctx.globalAlpha = 0.4;
        const bumpOffset = distance % 24;
        for (let x = -bumpOffset; x < W; x += 24) ctx.fillRect(x, groundY + 5, 8, 1);
        ctx.globalAlpha = 1;

        // obstacles
        ctx.fillStyle = fg;
        for (const ob of obstacles) {
            if (ob.type === 'cactus') drawCactus(ctx, ob.x, groundY, ob.w, ob.h);
            else drawBird(ctx, ob.x, groundY - ob.y - ob.h, Math.floor(birdFrameTimer / 0.2) % 2);
        }

        // dino
        drawDino(ctx, groundY, fg, bg);
    }

    function drawCactus(ctx: CanvasRenderingContext2D, x: number, groundY: number, w: number, h: number) {
        ctx.fillRect(x, groundY - h, w, h);
        const armW = 4;
        if (h > 26) {
            // left arm
            ctx.fillRect(x - armW, groundY - h + 10, armW, h * 0.3);
            ctx.fillRect(x - armW, groundY - h + 10, w * 0.6, armW);
            // right arm
            ctx.fillRect(x + w, groundY - h + 14, armW, h * 0.3);
            ctx.fillRect(x + w * 0.6, groundY - h + 14, w * 0.4 + armW, armW);
        }
    }

    function drawBird(ctx: CanvasRenderingContext2D, x: number, y: number, frame: number) {
        // body
        ctx.fillRect(x + 6, y + 6, 16, 6);
        // head + beak
        ctx.fillRect(x + 20, y + 2, 8, 6);
        ctx.fillRect(x + 27, y + 4, 4, 2);
        // wings flap
        if (frame === 0) ctx.fillRect(x + 8, y, 10, 6);
        else ctx.fillRect(x + 8, y + 12, 10, 6);
    }

    function drawDino(ctx: CanvasRenderingContext2D, groundY: number, fg: string, bg: string) {
        const x = DINO_X;
        const legFrame = Math.floor(distance / 20) % 2;
        if (ducking && dinoY <= 0) {
            // low long silhouette
            ctx.fillStyle = fg;
            ctx.fillRect(x, groundY - 18, 34, 14);
            ctx.fillRect(x + 26, groundY - DINO_DUCK_H, 14, 10);
            ctx.fillRect(x - 6, groundY - 16, 8, 6);
            ctx.fillStyle = bg;
            ctx.fillRect(x + 34, groundY - 21, 3, 3);
            ctx.fillStyle = fg;
            if (legFrame === 0) {
                ctx.fillRect(x + 4, groundY - 4, 5, 4);
                ctx.fillRect(x + 22, groundY - 4, 5, 4);
            } else {
                ctx.fillRect(x + 6, groundY - 4, 5, 4);
                ctx.fillRect(x + 20, groundY - 4, 5, 4);
            }
        } else {
            const y = groundY - dinoY - DINO_H;
            ctx.fillStyle = fg;
            // body
            ctx.fillRect(x, y + 12, 26, 20);
            // head + jaw
            ctx.fillRect(x + 16, y, 18, 16);
            ctx.fillRect(x + 16, y + 14, 12, 4);
            // tail
            ctx.fillRect(x - 8, y + 16, 10, 6);
            ctx.fillRect(x - 12, y + 18, 6, 4);
            // eye
            ctx.fillStyle = bg;
            ctx.fillRect(x + 27, y + 4, 3, 3);
            ctx.fillStyle = fg;
            // arm
            ctx.fillRect(x + 24, y + 18, 6, 4);
            // legs
            if (dinoY > 0) {
                ctx.fillRect(x + 6, y + 30, 6, 9);
                ctx.fillRect(x + 16, y + 30, 6, 9);
            } else if (legFrame === 0) {
                ctx.fillRect(x + 6, y + 30, 6, 14);
                ctx.fillRect(x + 16, y + 30, 6, 14);
            } else {
                ctx.fillRect(x + 4, y + 30, 6, 14);
                ctx.fillRect(x + 18, y + 30, 6, 14);
            }
        }
    }

    // ---- lifecycle ----
    onMount(() => {
        try {
            const saved = localStorage.getItem(HIGHSCORE_KEY);
            if (saved) highScore = parseInt(saved, 10) || 0;
        } catch {
            // ignore
        }
        readTheme();
        resizeCanvas();
        if (container) {
            resizeObserver = new ResizeObserver(() => resizeCanvas());
            resizeObserver.observe(container);
        }
        // re-read colors when the app theme changes
        themeObserver = new MutationObserver(() => {
            readTheme();
            if (gameState !== 'running') draw();
        });
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
        // initial static render — container may not be laid out yet on the first
        // frame (dynamic import + flex layout), so retry until the width is real
        let initialAttempts = 0;
        const initialRender = () => {
            resizeCanvas();
            draw();
            if (cssWidth <= 0 && initialAttempts++ < 30) {
                requestAnimationFrame(initialRender);
            }
        };
        requestAnimationFrame(initialRender);
    });

    onDestroy(() => {
        cancelAnimationFrame(rafId);
        resizeObserver?.disconnect();
        themeObserver?.disconnect();
    });
</script>

<div class="w-full select-none" bind:this={container}>
    <div class="relative w-full overflow-hidden" style:height="{CANVAS_H}px">
        <canvas
            bind:this={canvas}
            class="block w-full"
            style:height="{CANVAS_H}px"
            style:touch-action="none"
            aria-label="Chrome Dino minigame"
            tabindex="0"
            onkeydown={handleKeyDown}
            onkeyup={handleKeyUp}
            onblur={() => setDuck(false)}
            onpointerdown={handlePointerDown}
        ></canvas>

        <!-- score overlay -->
        <div class="absolute right-2 top-1 flex gap-3 font-mono text-sm pointer-events-none" style="color:{themeColors.fg}">
            <span class="opacity-60">HI {highScore}</span>
            <span>{String(score).padStart(5, '0')}</span>
        </div>

        {#if gameState === 'idle'}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
                class="absolute inset-0 flex flex-col items-center justify-center gap-1 cursor-pointer bg-bgcolor/40"
                onclick={handleStartClick}
            >
                <span class="font-semibold text-sm" style="color:{themeColors.fg}">{language.dinoPressStart}</span>
                <span class="text-xs opacity-60" style="color:{themeColors.fg}">{language.dinoWaitingDescription}</span>
            </div>
        {:else if gameState === 'frozen'}
            <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bgcolor/90">
                <span class="font-bold text-base text-green-500">{language.dinoResponseArrived}</span>
                <span class="text-sm" style="color:{themeColors.fg}">{language.dinoScore}: {score} / HI: {highScore}</span>
                {#if frozenMessage}
                    <span class="text-xs opacity-70">{frozenMessage}</span>
                {/if}
            </div>
        {:else if gameState === 'over'}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
                class="absolute inset-0 flex flex-col items-center justify-center gap-1 cursor-pointer bg-bgcolor/60"
                onclick={handleRestartClick}
            >
                <span class="font-bold text-base" style="color:{themeColors.fg}">{language.dinoGameOver}</span>
                <span class="text-xs opacity-70" style="color:{themeColors.fg}">
                    {isNewHighScore ? language.dinoNewHighScore : language.dinoTapToRestart}
                </span>
            </div>
        {/if}
    </div>
</div>