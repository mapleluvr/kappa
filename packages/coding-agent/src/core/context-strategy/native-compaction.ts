/** kappa-agent does not provide a compaction service. Compaction is implemented by a kappa extension. */
export const NATIVE_COMPACTION_DISABLED_CODE = "native_compaction_disabled";

export const NATIVE_COMPACTION_DISABLED_MESSAGE =
	"kappa-agent does not provide compaction; load a Context Strategy extension such as kappa-dynamite";
