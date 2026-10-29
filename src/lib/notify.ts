import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export const Urgency = MessageTray.Urgency;

export interface NotifyOptions {
    title: string;
    body?: string;
    /** a MessageTray.Urgency */
    urgency?: MessageTray.Urgency;
    /** stay in the tray after an action is used */
    resident?: boolean;
    /** overrides the Tuple icon */
    iconName?: string | null;
    /** [label, callback] pairs */
    actions?: Array<[string, () => void]>;
}

/** One message-tray source ("Tuple") shared by all of the extension's notifications. */
export class Notifier {
    private _gicon: Gio.Icon;
    private _source: MessageTray.Source | null;

    constructor(gicon: Gio.Icon) {
        this._gicon = gicon;
        this._source = null;
    }

    private _getSource(): MessageTray.Source {
        if (!this._source) {
            const source = new MessageTray.Source({title: 'Tuple', icon: this._gicon});
            source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(source);
            this._source = source;
        }
        return this._source;
    }

    notify({
        title, body = '', urgency = Urgency.NORMAL, resident = false, iconName = null, actions = [],
    }: NotifyOptions): MessageTray.Notification {
        const source = this._getSource();
        const notification = new MessageTray.Notification({
            source,
            title,
            body,
            urgency,
            resident,
            isTransient: urgency === Urgency.LOW,
        });
        if (iconName)
            notification.iconName = iconName;
        for (const [label, callback] of actions)
            notification.addAction(label, callback);
        source.addNotification(notification);
        return notification;
    }

    error(title: string, message: string): MessageTray.Notification {
        return this.notify({title, body: message, iconName: 'dialog-warning-symbolic'});
    }

    destroy() {
        this._source?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._source = null;
    }
}
