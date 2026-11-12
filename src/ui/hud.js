import * as THREE from 'three';
import { STATS } from '../../stats.js';

export const hudMethods = {
    // Short player-facing message. kind: 'info' | 'warn' | 'danger'.
    notify(text, { kind = 'info', ttl = 3.5 } = {}) {
        const banner = document.getElementById('squad-order-banner');
        if (!banner) return;
        banner.textContent = text;
        banner.classList.toggle('active-assault', kind !== 'info');
    },

    flashCrosshairHit(isHeadshot) {
        const hm = document.getElementById('hit-marker');
        if (!hm) return;
        hm.className = isHeadshot ? 'hit-head' : 'hit-body';
        hm.style.opacity = '1';
        clearTimeout(this._hmTimer);
        this._hmTimer = setTimeout(() => {
            hm.style.opacity = '0';
        }, 140);
    },

    pushKillFeed(killer, victim, zoneLabel, distMeters, weaponName) {
        const feed = document.getElementById('kill-feed');
        if (!feed) return;
        const row = document.createElement('div');
        row.className = 'kill-item';
        row.innerHTML = `<span class="k-atk">${killer}</span> <span class="k-wep">[${weaponName} • ${zoneLabel}]</span> <span class="k-vic">${victim}</span> <span class="k-dst">${distMeters}м</span>`;
        feed.prepend(row);
        while (feed.children.length > 6) {
            feed.removeChild(feed.lastChild);
        }
        setTimeout(() => {
            if (row.parentNode) row.parentNode.removeChild(row);
        }, 7500);
    },

    updateScoreHUD() {
        const kEl = document.getElementById('hud-kills');
        const hEl = document.getElementById('hud-headshots');
        if (kEl) kEl.textContent = String(this.killsCount);
        if (hEl) hEl.textContent = String(this.headshotsCount);
    },

    updateWeaponHUD() {
        const wNameEl = document.getElementById('hud-weapon-name');
        const wAmmoEl = document.getElementById('hud-ammo-count');
        const wStateEl = document.getElementById('hud-reload-state');

        if (this.playerVehicleState.vehicle && this.playerVehicleState.role === 'DRIVER') {
            const v = this.playerVehicleState.vehicle;
            if (wNameEl) wNameEl.textContent = `${v.name} • ${v.spec.weaponName}`;
            if (wAmmoEl) wAmmoEl.textContent = `${v.speedKmh} КМ/Ч | БК: ∞`;
            if (wStateEl) {
                const desantCount = v.desantUnits.filter((u) => u !== null).length;
                wStateEl.textContent = `ДЕСАНТ НА БРОНЕ: ${desantCount}/${v.spec.desantSlots.length} БОЙЦОВ [H — ПОСАДКА/ВЫСАДКА]`;
                wStateEl.style.color = '#8fe88f';
            }
            return;
        }

        const key = this.loadoutKeys[this.currentWeaponIdx];
        const wStat = STATS.WEAPONS[key];
        const wState = this.weaponStates[key];

        if (wNameEl) wNameEl.textContent = wStat.name;
        if (wAmmoEl) {
            if (wState.mag > wStat.magCapacity) {
                wAmmoEl.textContent = `${wStat.magCapacity}+1 / ${wState.reserve}`;
            } else {
                wAmmoEl.textContent = `${wState.mag} / ${wState.reserve}`;
            }
        }
        if (wStateEl) {
            if (wState.reloading) {
                wStateEl.textContent = wState.reloadState === 'TACTICAL_RELOAD'
                    ? 'ТАКТИЧЕСКАЯ ПЕРЕЗАРЯДКА (ПАТРОН В ПАТРОННИКЕ)...'
                    : 'ПОЛНАЯ ПЕРЕЗАРЯДКА (ЗАТВОР)...';
                wStateEl.style.color = '#ffaa33';
            } else {
                wStateEl.textContent = wState.chambered ? 'ГОТОВ К БОЮ [ПАТРОН В ПАТРОННИКЕ]' : 'ПУСТОЙ МАГАЗИН [R]';
                wStateEl.style.color = wState.chambered ? '#8fe88f' : '#ff5555';
            }
        }
    },
};
