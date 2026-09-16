/** Prefer Kappa operator env names; fall back to inherited Pi debug knobs. */
export function readCompatEnv(env: NodeJS.ProcessEnv, kappaName: string, piName: string): string | undefined {
	const kappa = env[kappaName];
	if (kappa !== undefined && kappa.length > 0) {
		return kappa;
	}
	const pi = env[piName];
	if (pi !== undefined && pi.length > 0) {
		return pi;
	}
	return undefined;
}
