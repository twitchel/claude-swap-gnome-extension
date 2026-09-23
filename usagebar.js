import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {barGeometry} from './format.js';

/**
 * A single usage bar: severity-coloured fill on a track, with a tick marking
 * the auto-switch trigger.
 *
 * Drawn with Cairo rather than assembled from Unicode block glyphs the way
 * claude-swap's TUI does it. The TUI can rely on a monospace grid; the shell
 * menu is set in Cantarell, which is proportional, so glyph runs would come
 * out ragged and the tick would drift off the value it marks.
 *
 * Colours come from the stylesheet via the theme node, so they stay themeable
 * instead of being frozen into JS.
 */
export const UsageBar = GObject.registerClass(
class UsageBar extends St.DrawingArea {
    _init(params = {}) {
        super._init({
            style_class: 'cswap-bar',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            ...params,
        });

        this._pct = null;
        this._threshold = null;

        this.connect('repaint', () => this._repaint());
    }

    /**
     * @param {number|null} pct utilization, 0-100
     * @param {number|null} threshold auto-switch trigger, for the tick
     * @param {string} severity 'ok' | 'warn' | 'crit', from format.severityOf
     */
    setValue(pct, threshold, severity) {
        this._pct = pct;
        this._threshold = threshold;

        for (const cls of ['cswap-bar-ok', 'cswap-bar-warn', 'cswap-bar-crit'])
            this.remove_style_class_name(cls);
        this.add_style_class_name(`cswap-bar-${severity}`);

        this.queue_repaint();
    }

    _color(node, property, fallback) {
        const [found, color] = node.lookup_color(property, true);
        return found ? color : fallback;
    }

    _setSource(cr, color) {
        cr.setSourceRGBA(
            color.red / 255, color.green / 255,
            color.blue / 255, color.alpha / 255);
    }

    _roundedRect(cr, x, y, width, height, radius) {
        if (width <= 0)
            return;
        const r = Math.min(radius, width / 2, height / 2);
        cr.newSubPath();
        cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
    }

    _repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            if (width <= 0 || height <= 0)
                return;

            const node = this.get_theme_node();
            const fillColor = node.get_foreground_color();
            const trackColor = this._color(node, '-cswap-track-color', fillColor);
            const tickColor = this._color(node, '-cswap-tick-color', fillColor);

            const {fillWidth, tickX} =
                barGeometry(this._pct, this._threshold, width);
            const radius = height / 2;

            this._setSource(cr, trackColor);
            this._roundedRect(cr, 0, 0, width, height, radius);
            cr.fill();

            if (fillWidth > 0) {
                this._setSource(cr, fillColor);
                this._roundedRect(cr, 0, 0, fillWidth, height, radius);
                cr.fill();
            }

            if (tickX !== null) {
                // A hairline that reads at 1x and stays visible on HiDPI.
                const tickWidth = Math.max(1, Math.round(height / 6));
                this._setSource(cr, tickColor);
                cr.rectangle(tickX, 0, tickWidth, height);
                cr.fill();
            }
        } finally {
            cr.$dispose();
        }
    }
});
