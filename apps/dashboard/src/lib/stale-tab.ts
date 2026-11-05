/**
 * A tab that was open while the server was updated keeps running the OLD page code until it is reloaded (a browser may do that by itself when a hidden tab
 * comes back). The server's version is read when the page starts and looked at again now and then: a different one means this page is out of date.
 */
export const isStale = (loaded: string | null | undefined, current: string | null | undefined): boolean => Boolean(loaded) && Boolean(current) && loaded !== current;
