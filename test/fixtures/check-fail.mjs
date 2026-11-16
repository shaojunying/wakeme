// A health check that always speaks up.
console.log(`loss is NaN (log ${process.env.WAKEME_LOG ? 'known' : 'unknown'})`);
process.exit(1);
