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
		})
		.catch(function(error) {
			console.error("MMM-Todoist: Failed to auto-complete overdue tasks:", error.message);
		});
	},

	fetchTodos : function() {
		var self = this;
		var accessCode = self.config.accessToken;

		if (!axios) {
			console.error("MMM-Todoist: axios is not available. Please run 'npm install' in modules/MMM-Todoist");
			self.sendSocketNotification("FETCH_ERROR", { error: "Missing dependency: axios" });
			return;
		}
		
		if (!accessCode || accessCode === "") {
			console.error("MMM-Todoist: AccessToken not set!");
			self.sendSocketNotification("FETCH_ERROR", {
				error: "AccessToken not configured"
			});
			return;
		}

		var url = self.config.apiBase + "/" + self.config.apiVersion + "/" + self.config.todoistEndpoint;
		var params = new URLSearchParams();
		params.append("sync_token", "*");
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
					self.sendSocketNotification("FETCH_ERROR", {
						error: "Invalid response format"
					});
					return;
				}

				if (self.config.autoCompleteOverdueTasks) {
					var today = new Date();
					today.setHours(0, 0, 0, 0);

					var overdueItems = taskJson.items.filter(function(item) {
						if (!item.due) return false;
						var dueDate = self.parseDueDate(item.due.date);
						dueDate.setHours(0, 0, 0, 0);
						return dueDate < today;
					});

					if (overdueItems.length > 0) {
						var overdueIds = new Set(overdueItems.map(function(item) { return item.id; }));
						taskJson.items = taskJson.items.filter(function(item) { return !overdueIds.has(item.id); });
						if (self.config.debug) {
							console.log("MMM-Todoist: Auto-completing " + overdueItems.length + " overdue task(s):", overdueItems.map(function(i) { return i.content; }));
						}
						self.completeOverdueTasks(overdueItems);
					}
				}

				let markdownConverter = null;
				if (showdown) {
					markdownConverter = new showdown.Converter();
				}

				taskJson.items.forEach((item) => {
					if (item.content) {
						if (markdownConverter) {
							item.contentHtml = markdownConverter.makeHtml(item.content);
						} else {
							item.contentHtml = item.content;
						}
					}
				});

				taskJson.accessToken = accessCode;
				self.sendSocketNotification("TASKS", taskJson);
			} else {
				console.error("MMM-Todoist: Unexpected response status: " + response.status);
				self.sendSocketNotification("FETCH_ERROR", {
					error: "Unexpected response status: " + response.status
				});
			}
		})
		.catch(function(error) {
			var errorMessage = "Unknown error";
			if (error.response) {
				// The request was made and the server responded with a status code
				// that falls out of the range of 2xx
				errorMessage = "API Error: " + error.response.status + " - " + (error.response.data ? JSON.stringify(error.response.data) : error.message);
				console.error("MMM-Todoist API Error:", error.response.status, error.response.data);
			} else if (error.request) {
				// The request was made but no response was received
				errorMessage = "No response from Todoist API: " + error.message;
				console.error("MMM-Todoist: No response received:", error.message);
			} else {
				// Something happened in setting up the request that triggered an Error
				errorMessage = "Request setup error: " + error.message;
				console.error("MMM-Todoist Request Error:", error.message);
			}
			
			self.sendSocketNotification("FETCH_ERROR", {
				error: errorMessage
			});
		});
	}
});