"use strict";

const axios = require("axios");

const ACCESS_TOKEN = process.env.TODOIST_TOKEN;

if (!ACCESS_TOKEN) {
	console.error("Usage: TODOIST_TOKEN=your_token node check-recurrence.js");
	process.exit(1);
}

const params = new URLSearchParams();
params.append("sync_token", "*");
params.append("resource_types", '["items", "projects"]');

axios.post("https://api.todoist.com/api/v1/sync", params.toString(), {
	headers: {
		"content-type": "application/x-www-form-urlencoded",
		"Authorization": "Bearer " + ACCESS_TOKEN
	}
})
.then(function(response) {
	const { items, projects } = response.data;
	const projectMap = {};
	projects.forEach(p => { projectMap[p.id] = p.name; });

	const recurring = items.filter(item => item.due && item.due.is_recurring);

	if (recurring.length === 0) {
		console.log("No recurring tasks found.");
		return;
	}

	console.log("\n=== Recurring Tasks ===\n");

	const fixed = [];
	const relative = [];

	recurring.forEach(item => {
		const dueString = item.due.string || "";
		// Relative recurrences contain "after" or use "every X days/weeks" without a fixed anchor
		const isRelative = /after/i.test(dueString);
		const entry = {
			content: item.content,
			project: projectMap[item.project_id] || item.project_id,
			due: item.due.date,
			string: dueString,
			lang: item.due.lang
		};
		if (isRelative) {
			relative.push(entry);
		} else {
			fixed.push(entry);
		}
	});

	if (fixed.length > 0) {
		console.log("FIXED recurrence (safe to auto-complete late — schedule won't shift):");
		fixed.forEach(t => {
			console.log(`  [${t.project}] "${t.content}"`);
			console.log(`    due: ${t.due}  rule: "${t.string}"`);
		});
	}

	if (relative.length > 0) {
		console.log("\nRELATIVE recurrence (completing late will shift the schedule):");
		relative.forEach(t => {
			console.log(`  [${t.project}] "${t.content}"`);
			console.log(`    due: ${t.due}  rule: "${t.string}"`);
		});
	}

	console.log(`\nTotal: ${fixed.length} fixed, ${relative.length} relative\n`);
})
.catch(function(error) {
	console.error("API error:", error.response ? error.response.status + " " + JSON.stringify(error.response.data) : error.message);
});
