/**
 * The card's background thread. In a real host this is where the network
 * lives (M13): `onNavigate` on the main thread posts the request here, this
 * thread fetches, and the page goes back as JSON. This card needs no network
 * for its pages; it only relays device reports to the collector the device
 * script runs, when one is configured at build time.
 */

import { relayDeviceReports } from '@airo-js/lynx/device';

if (AIRO_LYNX_COLLECTOR) relayDeviceReports(lynx, fetch, AIRO_LYNX_COLLECTOR);
