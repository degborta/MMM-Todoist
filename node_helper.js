"use strict";

/* Magic Mirror
 * Module: MMM-Todoist
 *
 * By Chris Brooker
 *
 * MIT Licensed.
 */

const NodeHelper = require("node_helper");

let axios;
let showdown;

try {
	axios = require("axios");
} catch (e) {
	axios = null;
	console.error("MMM-Todoist: missing dependency 'axios'. Run 'npm install' in the module folder.", e && e.message);
}

try {
	showdown = require("showdown");
} catch (e) {
	showdown = null;
	console.error("MMM-Todoist: missing dependency 'showdown'. Run 'npm install' in the module folder.", e && e.message);
}

module.exports = NodeHelper.create({
	start: function() {
		console.log("Starting node helper for: " + this.name);
		this.completedTaskIds = new Set();
		this.syncToken = "*";
		this.cachedData = null;
	},

	socketNotificationReceived: function(notification, payload) {
		if (notification === "FETCH_TODOIST") {
			this.config = payload;
			this.fetchTodos();
		}
	},

	parseDueDate: function(dateStr) {
		var parts = dateStr.split(/\D/).map(Number);
		if (dateStr[dateStr.length - 1] === "Z") {
			return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] || 0, parts[4] || 0, parts[5] || 0));
		}
		return new Date(parts[0], parts[1] - 1, parts[2], parts[3] || 0, parts[4] || 0, parts[5] || 0);
	},

	mergeDelta: function(delta) {
		var cache = this.cachedData;
		["items", "projects", "collaborators", "labels"].forEach(function(key) {
			if (!delta[key] || !Array.isArray(delta[key])) return;
			delta[key].forEach(function(incoming) {
				var idx = cache[key].findIndex(function(existing) { return existing.id === incoming.id; });
				if (incoming.is_deleted || incoming.checked) {
					if (idx !== -1) cache[key].splice(idx, 1);
				} else if (idx !== -1) {
					cache[key][idx] = incoming;
				} else {
					cache[key].push(incoming);
				}
			});
		});
		if (delta.user) cache.user = delta.user;
	},

	completeOverdueTasks: function(items) {
		var self = this;
		var { randomUUID } = require("crypto");

		var commands = items.map(function(item) {
			return { type: "item_close", uuid: randomUUID(), args: { id: item.id } };
		});

		var params = new URLSearchParams();
		params.append("commands", JSON.stringify(commands));

		axios.post(self.config.apiBase + "/" + self.config.apiVersion + "/" + self.config.todoistEndpoint, params.toString(), {
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"Authorization": "Bearer " + self.config.accessToken
			}
		})
		.then(function(response) {
			if (self.config.debug) {
				var status = response.data && response.data.sync_status ? response.data.sync_status : {};
				var names = items.map(function(i) { return i.content; });
				console.log("MMM-Todoist: Auto-completed " + items.length + " overdue task(s):", names);
				console.log("MMM-Todoist: sync_status:", JSON.stringify(status));
			}
			// Force a full resync so completed tasks are cleared from cache
			self.syncToken = "*";
			self.cachedData = null;
		})
		.catch(function(error) {
			console.error("MMM-Todoist: Failed to auto-complete overdue tasks:", error.message);
		});
	},

	fetchTodos: function(retryCount) {
		var self = this;
		retryCount = retryCount || 0;
		var accessCode = self.config.accessToken;

		if (!axios) {
			console.error("MMM-Todoist: axios is not available. Please run 'npm install' in modules/MMM-Todoist");
			self.sendSocketNotification("FETCH_ERROR", { error: "Missing dependency: axios" });
			return;
		}

		if (!accessCode || accessCode === "") {
			console.error("MMM-Todoist: AccessToken not set!");
			self.sendSocketNotification("FETCH_ERROR", { error: "AccessToken not configured" });
			return;
		}

		var url = self.config.apiBase + "/" + self.config.apiVersion + "/" + self.config.todoistEndpoint;
		var params = new URLSearchParams();
		params.append("sync_token", self.syncToken);
		params.append("resource_types", self.config.todoistResourceType);

		axios.post(url, params.toString(), {
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"cache-control": "no-cache",
				"Authorization": "Bearer " + accessCode
			}
		})
		.then(function(response) {
			if (self.config.debug) {
				console.log("MMM-Todoist API Response:", JSON.stringify(response.data, null, 2));
			}

			if (response.status === 200 && response.data) {
				var taskJson = response.data;

				if (!taskJson.items || !Array.isArray(taskJson.items)) {
					console.error("MMM-Todoist: Invalid response format - items array missing");
					self.sendSocketNotification("FETCH_ERROR", { error: "Invalid response format" });
					return;
				}

				var isFullSync = self.syncToken === "*";

				if (taskJson.sync_token) {
					self.syncToken = taskJson.sync_token;
				}

				if (isFullSync || !self.cachedData) {
					self.cachedData = {
						items: taskJson.items || [],
						projects: taskJson.projects || [],
						collaborators: taskJson.collaborators || [],
						user: taskJson.user || null,
						labels: taskJson.labels || []
					};
				} else {
					self.mergeDelta(taskJson);
				}

				// Work on a shallow copy so we don't mutate the cache
				var data = {
					items: self.cachedData.items.filter(function(item) {
						return !item.checked && !item.is_deleted;
					}),
					projects: self.cachedData.projects,
					collaborators: self.cachedData.collaborators,
					user: self.cachedData.user,
					labels: self.cachedData.labels
				};

				if (self.config.autoCompleteOverdueTasks) {
					var today = new Date();
					today.setHours(0, 0, 0, 0);

					var overdueItems = data.items.filter(function(item) {
						if (!item.due) return false;
						var dueDate = self.parseDueDate(item.due.date);
						dueDate.setHours(0, 0, 0, 0);
						return dueDate < today;
					});

					if (overdueItems.length > 0) {
						var overdueIds = new Set(overdueItems.map(function(item) { return item.id; }));
						data.items = data.items.filter(function(item) { return !overdueIds.has(item.id); });

						var newItems = overdueItems.filter(function(item) { return !self.completedTaskIds.has(item.id); });
						if (newItems.length > 0) {
							newItems.forEach(function(item) { self.completedTaskIds.add(item.id); });
							if (self.config.debug) {
								console.log("MMM-Todoist: Auto-completing " + newItems.length + " overdue task(s):", newItems.map(function(i) { return i.content; }));
							}
							self.completeOverdueTasks(newItems);
						}
					}
				}

				let markdownConverter = null;
				if (showdown) {
					markdownConverter = new showdown.Converter();
				}

				data.items.forEach((item) => {
					if (item.content) {
						if (markdownConverter) {
							item.contentHtml = markdownConverter.makeHtml(item.content);
						} else {
							item.contentHtml = item.content;
						}
					}
				});

				data.accessToken = accessCode;
				self.sendSocketNotification("TASKS", data);
			} else {
				console.error("MMM-Todoist: Unexpected response status: " + response.status);
				self.sendSocketNotification("FETCH_ERROR", { error: "Unexpected response status: " + response.status });
			}
		})
		.catch(function(error) {
			var errorMessage = "Unknown error";
			if (error.response) {
				errorMessage = "API Error: " + error.response.status + " - " + (error.response.data ? JSON.stringify(error.response.data) : error.message);
				console.error("MMM-Todoist API Error:", error.response.status, error.response.data);

				// Retry on 503 (service unavailable) with exponential backoff
				if (error.response.status === 503 && retryCount < 3) {
					var delay = Math.pow(2, retryCount) * 10000; // 10s, 20s, 40s
					console.log("MMM-Todoist: 503 received, retrying in " + (delay / 1000) + "s (attempt " + (retryCount + 1) + "/3)");
					setTimeout(function() { self.fetchTodos(retryCount + 1); }, delay);
					return;
				}
			} else if (error.request) {
				errorMessage = "No response from Todoist API: " + error.message;
				console.error("MMM-Todoist: No response received:", error.message);
			} else {
				errorMessage = "Request setup error: " + error.message;
				console.error("MMM-Todoist Request Error:", error.message);
			}

			// Reset to full sync on error so next attempt gets fresh data
			self.syncToken = "*";
			self.cachedData = null;

			self.sendSocketNotification("FETCH_ERROR", { error: errorMessage });
		});
	}
});
