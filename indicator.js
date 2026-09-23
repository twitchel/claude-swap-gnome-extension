import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {panelText, iconState, accountLabel, usageSummary, accountsOf,
    snapshotSignature, severityOf, rolledWeeklyWindow, liveCountdown}
    from './format.js';
import {UsageBar} from './usagebar.js';

const SWITCH_FLASH_MS = 3000;

export const ClaudeSwapIndicator = GObject.registerClass(
class ClaudeSwapIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Claude Swap');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._flashId = 0;
        this._stale = false;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${extension.path}/icons/claude-robot-symbolic.svg`),
            style_class: 'system-status-icon',
        });

        this._label = new St.Label({
            style_class: 'cswap-label',
            y_align: Clutter.ActorAlign.CENTER,
            text: '',
        });

        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._settingsIds = [
            this._settings.connect('changed::panel-text', () => this._reRender()),
            this._settings.connect('changed::show-account-name', () => this._reRender()),
            this._settings.connect('changed::colour-code-icon', () => this._reRender()),
        ];

        this._snapshot = null;
        this._handlers = {};
        this._notFoundPaths = null;
        this._staleAgeText = '';
        this._threshold = null;
        this._menuSignature = null;
        this._pendingRebuild = false;

        this._client = null;
        this._timerId = 0;
        this._destroyed = false;
        this._failures = 0;
        this._lastGoodAt = 0;
        this._blockedNotifiedAt = 0;

        this._settingsIds.push(
            this._settings.connect('changed::refresh-interval',
                () => this._restartTimer()));

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen) {
                // A refresh that landed while the menu was open was deferred so
                // it could not collapse a submenu under the cursor. Apply it now.
                if (this._pendingRebuild)
                    this._safeRebuild(true);
                return;
            }
            if (!this._client?.found)
                return;
            // Sequential, not concurrent: the client is single-flight, so
            // firing both at once would reject one of them as busy.
            this._poll()
                .then(() => this._client?.getThreshold())
                .then(pct => {
                    if (!this._destroyed && pct !== undefined && pct !== null)
                        this.setThresholdChoices(pct);
                })
                .catch(() => {});
        });
    }

    /** Store a snapshot and redraw. Pass null to show the unknown state. */
    render(snapshot) {
        this._snapshot = snapshot;
        this._notFoundPaths = null;
        this._reRender();
        this._safeRebuild();
    }

    _activeAccount() {
        return accountsOf(this._snapshot).find(a => a.active) ?? null;
    }

    _reRender() {
        const now = Date.now();
        const account = this._activeAccount();

        const prefs = {
            panelText: this._settings.get_string('panel-text'),
            showAccountName: this._settings.get_boolean('show-account-name'),
        };

        const text = panelText(account, prefs, now);
        this._label.text = text;
        this._label.visible = text !== '';

        for (const cls of ['cswap-ok', 'cswap-warn', 'cswap-crit', 'cswap-stale'])
            this._icon.remove_style_class_name(cls);

        if (this._settings.get_boolean('colour-code-icon'))
            this._icon.add_style_class_name(
                `cswap-${iconState(account, now, this._threshold)}`);

        if (this._stale)
            this._icon.add_style_class_name('cswap-stale');
    }

    setStale(isStale) {
        this._stale = isStale;
        this._reRender();
    }

    /** Tint the icon with the accent colour briefly after an auto-switch. */
    flashSwitched() {
        if (this._flashId) {
            GLib.Source.remove(this._flashId);
            this._flashId = 0;
        }
        this._icon.add_style_class_name('cswap-switched');
        this._flashId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SWITCH_FLASH_MS, () => {
                this._icon.remove_style_class_name('cswap-switched');
                this._flashId = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    setHandlers(handlers) {
        this._handlers = handlers;
    }

    /** Show the terminal "no binary" state instead of account rows. */
    setNotFound(triedPaths) {
        this._notFoundPaths = triedPaths;
        this._stale = true;
        this._reRender();
        this._safeRebuild(true);
    }

    setStaleAge(text) {
        this._staleAgeText = text;
    }

    setThresholdChoices(current) {
        if (this._threshold === current)
            return;
        this._threshold = current;
        this._safeRebuild();
    }

    /** One `5h ▇▇▇▇░░┃░ 70% 3h 41m` line. */
    _addBarRow(parent, label, window, now) {
        const row = new St.BoxLayout({style_class: 'cswap-bar-row', x_expand: true});

        row.add_child(new St.Label({
            text: label,
            style_class: 'cswap-bar-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const pct = window && typeof window.pct === 'number' ? window.pct : null;

        const bar = new UsageBar();
        bar.setValue(pct, this._threshold, severityOf(pct, this._threshold));
        row.add_child(bar);

        row.add_child(new St.Label({
            text: pct === null ? '  –' : `${pct.toFixed(0)}%`,
            style_class: 'cswap-bar-pct',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const countdown = window ? liveCountdown(window.resetsAt, now) : null;
        row.add_child(new St.Label({
            text: countdown ?? '',
            style_class: 'cswap-bar-reset',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        parent.add_child(row);
    }

    _addAccountRow(account) {
        const item = new PopupMenu.PopupBaseMenuItem();
        const box = new St.BoxLayout({vertical: true, x_expand: true});
        const now = Date.now();

        const name = new St.Label({text: accountLabel(account)});
        box.add_child(name);
        // Without this a screen reader announces nothing for the row:
        // PopupMenuItem sets it for you, a hand-built PopupBaseMenuItem does not.
        item.label_actor = name;

        const usable = account?.usageStatus === 'ok' && account?.usage;
        if (usable) {
            this._addBarRow(box, '5h', account.usage.fiveHour, now);
            this._addBarRow(box, '7d',
                rolledWeeklyWindow(account.usage.sevenDay, now), now);
        } else {
            // auth failure, backoff, or never polled — the text form says why
            box.add_child(new St.Label({
                text: usageSummary(account, now),
                style_class: 'cswap-usage',
            }));
        }

        item.add_child(box);
        // NO_DOT, not NONE: NONE omits the `popup-ornamented-menu-item` class,
        // whose 6px left padding would leave inactive rows misaligned with the
        // active one — obvious once the rows contain bars.
        item.setOrnament(account.active
            ? PopupMenu.Ornament.DOT
            : PopupMenu.Ornament.NO_DOT);

        item.connect('activate', () => {
            if (this._handlers.onSwitchTo)
                this._handlers.onSwitchTo(account.number);
        });

        this.menu.addMenuItem(item);
    }

    _addInsensitive(text, styleClass = null) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        if (styleClass)
            item.label.add_style_class_name(styleClass);
        this.menu.addMenuItem(item);
        return item;
    }

    /**
     * Rebuild only when the rows would actually differ, and never out from
     * under an open submenu — removeAll() destroys it mid-interaction.
     * Any failure here must not propagate: this runs from a GLib callback.
     */
    _safeRebuild(force = false) {
        try {
            const sig = [
                this._notFoundPaths ? 'nf' : '',
                this._staleAgeText,
                this._threshold,
                snapshotSignature(this._snapshot, Date.now()),
            ].join('\x1e');

            if (!force && sig === this._menuSignature)
                return;

            if (!force && this.menu.isOpen && this._hasOpenSubMenu()) {
                this._pendingRebuild = true;
                return;
            }

            this._menuSignature = sig;
            this._pendingRebuild = false;
            this._rebuildMenu();
        } catch (e) {
            logError(e, 'claude-swap: menu rebuild failed');
        }
    }

    _hasOpenSubMenu() {
        return this.menu._getMenuItems()
            .some(item => item.menu && item.menu.isOpen);
    }

    _rebuildMenu() {
        this.menu.removeAll();

        if (this._notFoundPaths) {
            this._addInsensitive('cswap not found', 'cswap-error');
            for (const p of this._notFoundPaths)
                this._addInsensitive(`  ${p}`, 'cswap-usage');
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const prefs = new PopupMenu.PopupMenuItem('Set path in Settings…');
            prefs.connect('activate', () => this._handlers.onOpenPrefs?.());
            this.menu.addMenuItem(prefs);
            return;
        }

        if (this._staleAgeText)
            this._addInsensitive(this._staleAgeText, 'cswap-usage');

        const accounts = accountsOf(this._snapshot);
        if (accounts.length === 0)
            this._addInsensitive('No managed accounts');
        else
            accounts.forEach(a => this._addAccountRow(a));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        for (const [label, strategy] of [
            ['Rotate to next', null],
            ['Switch to best', 'best'],
            ['Next available', 'next-available'],
        ]) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => this._handlers.onSwitchBy?.(strategy));
            item.setSensitive(accounts.length > 0);
            this.menu.addMenuItem(item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const auto = new PopupMenu.PopupSwitchMenuItem(
            'Auto-switch', this._settings.get_boolean('auto-switch'));
        auto.connect('toggled', (_item, state) =>
            this._handlers.onToggleAuto?.(state));
        this.menu.addMenuItem(auto);

        const thresholdMenu = new PopupMenu.PopupSubMenuMenuItem(
            this._threshold === null
                ? 'Threshold'
                : `Threshold — ${this._threshold}%`);
        for (const pct of [80, 90, 95, 98]) {
            const choice = new PopupMenu.PopupMenuItem(`${pct}%`);
            if (pct === this._threshold)
                choice.setOrnament(PopupMenu.Ornament.DOT);
            choice.connect('activate', () => this._handlers.onSetThreshold?.(pct));
            thresholdMenu.menu.addMenuItem(choice);
        }
        this.menu.addMenuItem(thresholdMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refresh = new PopupMenu.PopupMenuItem('Refresh now');
        refresh.connect('activate', () => this._handlers.onRefresh?.());
        this.menu.addMenuItem(refresh);

        const settings = new PopupMenu.PopupMenuItem('Settings…');
        settings.connect('activate', () => this._handlers.onOpenPrefs?.());
        this.menu.addMenuItem(settings);
    }

    start(client) {
        // stop() sets _destroyed, and extension.js calls stop()/start() around
        // a cswap-path change. Without this reset the indicator would stay dead
        // after the user corrected the path — every poll would return early.
        this._destroyed = false;
        this._client = client;

        this.setHandlers({
            onSwitchTo: n => this._doSwitch(() => client.switchTo(n)),
            onSwitchBy: strategy => this._doSwitch(() =>
                strategy === null
                    ? client.rotate()
                    : client.switchBy(strategy)),
            onRefresh: () => this._userPoll(),
            onToggleAuto: state => this._settings.set_boolean('auto-switch', state),
            onSetThreshold: pct => this._doSetThreshold(pct),
            onOpenPrefs: () => this._extension.openPreferences(),
        });

        if (!client.found) {
            this.setNotFound(client.triedPaths);
            return;
        }

        // Seed the threshold now rather than waiting for the first menu open:
        // the bars draw their trigger tick from it, and the crit band follows it.
        this._poll()
            .then(() => this._client?.getThreshold())
            .then(pct => {
                if (!this._destroyed && pct !== undefined && pct !== null)
                    this.setThresholdChoices(pct);
            })
            .catch(() => {});
        this._restartTimer();
    }

    stop() {
        this._destroyed = true;
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        this._client?.destroy();
        this._client = null;
    }

    _interval() {
        // Back off after repeated failures so a broken cswap does not spawn a
        // process every minute forever.
        return this._failures >= 3
            ? 300
            : this._settings.get_int('refresh-interval');
    }

    _restartTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        if (this._destroyed || !this._client?.found)
            return;
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, this._interval(), () => {
                this._poll();
                return GLib.SOURCE_CONTINUE;
            });
    }

    async _poll() {
        if (this._destroyed || !this._client || this._client.busy)
            return;

        const wasBackedOff = this._failures >= 3;

        try {
            const snapshot = await this._client.listAccounts();
            if (this._destroyed)
                return;

            this._failures = 0;
            this._lastGoodAt = Date.now();
            this.setStaleAge('');
            this._stale = false;
            this.render(snapshot);

            if (wasBackedOff)
                this._restartTimer();

            if (this._settings.get_boolean('auto-switch'))
                await this._autoTick();
        } catch (e) {
            if (this._destroyed)
                return;
            this._failures++;
            console.warn(`claude-swap: refresh failed: ${e.message}`);
            this._markStale();
            if (this._failures === 3)
                this._restartTimer();
        }
    }

    _markStale() {
        if (this._lastGoodAt) {
            const mins = Math.floor((Date.now() - this._lastGoodAt) / 60000);
            this.setStaleAge(`stale — last read ${mins}m ago`);
        } else {
            this.setStaleAge('no usage data yet');
        }
        this.setStale(true);
        this._safeRebuild(true);
    }

    async _autoTick() {
        try {
            const {code, events} = await this._client.autoOnce({});
            if (this._destroyed)
                return;

            if (code === 0) {
                this.flashSwitched();
                if (this._settings.get_boolean('notify-on-switch')) {
                    const to = events.find(e => e.to !== undefined)?.to;
                    Main.notify('Claude Swap',
                        to !== undefined
                            ? `Switched to account ${to}`
                            : 'Switched account');
                }
                await this._poll();
            } else if (code === 3) {
                // Rate-limit this notification: an all-exhausted state would
                // otherwise fire one every tick.
                const now = Date.now();
                if (now - this._blockedNotifiedAt > 3600000) {
                    this._blockedNotifiedAt = now;
                    Main.notify('Claude Swap',
                        'No account has headroom to switch to');
                }
            } else if (code === 1) {
                console.warn('claude-swap: auto-switch tick reported an error');
            }
        } catch (e) {
            if (!this._destroyed)
                console.warn(`claude-swap: auto-switch failed: ${e.message}`);
        }
    }

    /** A refresh the user asked for: wait rather than silently no-op. */
    async _userPoll() {
        if (this._destroyed || !this._client)
            return;
        await this._client.whenIdle();
        if (!this._destroyed)
            await this._poll();
    }

    async _doSwitch(fn) {
        try {
            // The menu-open poll may still be running; the client is
            // single-flight, so issuing now would reject the click as "busy"
            // and surface an internal error message to the user.
            await this._client?.whenIdle();
            if (this._destroyed)
                return;
            await fn();
        } catch (e) {
            if (!this._destroyed)
                Main.notifyError('Claude Swap', e.message.split('\n')[0]);
        }
        // Refresh whether it worked or not, so the panel never shows a stale
        // active account after a failed switch.
        if (!this._destroyed) {
            await this._client?.whenIdle();
            if (!this._destroyed)
                await this._poll();
        }
    }

    async _doSetThreshold(pct) {
        try {
            await this._client.whenIdle();
            if (this._destroyed)
                return;
            await this._client.setThreshold(pct);
            if (!this._destroyed)
                this.setThresholdChoices(pct);
        } catch (e) {
            if (!this._destroyed)
                Main.notifyError('Claude Swap', e.message.split('\n')[0]);
        }
    }

    destroy() {
        this.stop();
        if (this._flashId) {
            GLib.Source.remove(this._flashId);
            this._flashId = 0;
        }
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        super.destroy();
    }
});
