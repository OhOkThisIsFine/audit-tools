export async function run(){ await acquire(); await inspect(); await release(); await archive(); await notify(); }
export async function dryRun(){ await acquire(); await inspect(); await release(); await archive(); await notify(); }
