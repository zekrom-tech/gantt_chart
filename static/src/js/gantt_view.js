/** @odoo-module **/

import { registry } from "@web/core/registry";
import { Layout } from "@web/search/layout";
import { Component, onWillStart, useState, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { GanttRenderer } from "./gantt_renderer";

export class GanttController extends Component {
    static template = "gantt_chart.GanttController";
    static components = { GanttRenderer };

    setup() {
        this.actionService = useService("action");
        this.orm = useService("orm");
        this.notification = useService("notification");

        this.state = useState({
            scale: 'month',
            groupBy: this.props.groupBy || 'project_id',
            ganttData: [],
            filteredData: [], // Filtered data for search/date range
            isLoading: false,
            // Default to View Only mode for safety - users must explicitly enable editing
            editable: false,
            hasCenteredToday: false,
            // Track currently selected task for color assignment
            selectedTaskId: null,
            // Search functionality
            searchQuery: '',
            // Date range filter
            dateRangeFilter: 'all',
            // Collapsible groups - stores collapsed group IDs
            collapsedGroups: new Set(),
        });
        
        // Bind keyboard handler
        this._onKeyDown = this._onKeyDown.bind(this);

        onWillStart(async () => {
            await this.loadGanttData();
            // Add keyboard listener
            document.addEventListener('keydown', this._onKeyDown);
        });
        
        onWillUpdateProps(async (nextProps) => {
            if (JSON.stringify(nextProps.domain) !== JSON.stringify(this.props.domain) ||
                nextProps.groupBy !== this.props.groupBy) {
                await this.loadGanttData(nextProps);
            }
        });
    }
    
    // Keyboard shortcuts handler
    _onKeyDown(ev) {
        // Only handle if Gantt view is visible
        if (!document.querySelector('.o_gantt_view')) return;
        
        // Escape - clear selection and search
        if (ev.key === 'Escape') {
            this.clearSearch();
            this.state.selectedTaskId = null;
            return;
        }
        
        // Ctrl+F - focus search
        if (ev.ctrlKey && ev.key === 'f') {
            ev.preventDefault();
            const searchInput = document.querySelector('.o_gantt_view input[type="text"]');
            if (searchInput) searchInput.focus();
            return;
        }
        
        // Arrow keys for navigation (when not in input)
        if (document.activeElement.tagName !== 'INPUT') {
            if (ev.key === 'ArrowLeft') {
                this.navigate('prev');
            } else if (ev.key === 'ArrowRight') {
                this.navigate('next');
            } else if (ev.key === 'Home') {
                this.navigate('today');
            }
        }
    }

    async loadGanttData(props = this.props) {
        this.state.isLoading = true;
        try {
            this.state.ganttData = await this.orm.call(
                props.resModel, 
                'get_gantt_data', 
                [],
                { 
                    domain: props.domain || [], 
                    group_by: this.state.groupBy 
                }
            );
            // Apply any active filters
            this.applyFilters();
            
            // After first successful load, center on today once
            if (!this.state.hasCenteredToday) {
                window.dispatchEvent(new CustomEvent('gantt-navigate', { detail: { type: 'today' } }));
                this.state.hasCenteredToday = true;
            }
        } catch (error) {
            this.notification.add("Failed to load Gantt data", { type: "danger" });
            console.error("Gantt data load error:", error);
        } finally {
            this.state.isLoading = false;
        }
    }
    
    // Apply search and date range filters
    applyFilters() {
        let filtered = JSON.parse(JSON.stringify(this.state.ganttData));
        
        // Apply search filter
        if (this.state.searchQuery) {
            const query = this.state.searchQuery.toLowerCase();
            filtered = filtered.map(group => ({
                ...group,
                tasks: group.tasks.filter(task => 
                    task.name.toLowerCase().includes(query) ||
                    (task.description && task.description.toLowerCase().includes(query))
                )
            })).filter(group => group.tasks.length > 0);
        }
        
        // Apply date range filter
        if (this.state.dateRangeFilter !== 'all') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            let startDate, endDate;
            
            switch (this.state.dateRangeFilter) {
                case 'week':
                    // Start of week (Monday)
                    startDate = new Date(today);
                    startDate.setDate(today.getDate() - today.getDay() + 1);
                    endDate = new Date(startDate);
                    endDate.setDate(startDate.getDate() + 6);
                    break;
                case 'month':
                    startDate = new Date(today.getFullYear(), today.getMonth(), 1);
                    endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
                    break;
                case 'quarter':
                    const quarter = Math.floor(today.getMonth() / 3);
                    startDate = new Date(today.getFullYear(), quarter * 3, 1);
                    endDate = new Date(today.getFullYear(), quarter * 3 + 3, 0);
                    break;
            }
            
            if (startDate && endDate) {
                filtered = filtered.map(group => ({
                    ...group,
                    tasks: group.tasks.filter(task => {
                        const taskStart = new Date(task.start_date);
                        const taskEnd = new Date(task.end_date);
                        // Task overlaps with the date range
                        return taskStart <= endDate && taskEnd >= startDate;
                    })
                })).filter(group => group.tasks.length > 0);
            }
        }
        
        // Remove collapsed groups
        if (this.state.collapsedGroups.size > 0) {
            filtered = filtered.map(group => ({
                ...group,
                tasks: this.state.collapsedGroups.has(group.id) ? [] : group.tasks,
                isCollapsed: this.state.collapsedGroups.has(group.id)
            }));
        }
        
        this.state.filteredData = filtered;
    }
    
    // Search input handler
    onSearchInput(ev) {
        this.state.searchQuery = ev.target.value;
        this.applyFilters();
    }
    
    // Clear search
    clearSearch() {
        this.state.searchQuery = '';
        this.applyFilters();
    }
    
    // Set date range filter
    setDateRange(range) {
        this.state.dateRangeFilter = range;
        this.applyFilters();
        
        // Show notification
        const labels = { week: 'This Week', month: 'This Month', quarter: 'This Quarter', all: 'All Tasks' };
        this.notification.add(`Showing: ${labels[range]}`, { type: "info" });
    }
    
    // Toggle group collapse
    toggleGroupCollapse(groupId) {
        if (this.state.collapsedGroups.has(groupId)) {
            this.state.collapsedGroups.delete(groupId);
        } else {
            this.state.collapsedGroups.add(groupId);
        }
        this.applyFilters();
    }
    
    // Get the data to render (filtered or full)
    get renderData() {
        return this.state.filteredData.length > 0 || this.state.searchQuery || this.state.dateRangeFilter !== 'all'
            ? this.state.filteredData 
            : this.state.ganttData;
    }

    async onTaskUpdated(ev) {
        const { taskId, startDate, endDate } = ev.detail;
        try {
            // Format dates properly for Odoo
            const formatDateForOdoo = (date) => {
                if (!date) return false;
                if (date instanceof Date) {
                    return date.toISOString().replace('Z', '').replace('T', ' ');
                }
                return date;
            };

            const updateData = {
                task_start_date: formatDateForOdoo(startDate),
                task_end_date: formatDateForOdoo(endDate),
            };

            await this.orm.write(this.props.resModel, [taskId], updateData);
            this.notification.add("Task updated successfully", { type: "success" });
            await this.loadGanttData();
        } catch (error) {
            this.notification.add("Failed to update task", { type: "danger" });
            console.error("Task update error:", error);
            await this.loadGanttData(); // Reload to revert changes on error
        }
    }

    onTaskClicked(ev) {
        const { taskId } = ev.detail;
        this.actionService.doAction({
            type: 'ir.actions.act_window',
            res_model: 'project.task',
            res_id: taskId,
            views: [[false, 'form']],
            target: 'new',
            context: { 
                create: false,
                // Ensure we're working with the correct date fields
                default_task_start_date: true,
                default_task_end_date: true,
                // Force reload of the record to get latest data
                force_reload: true,
            },
        }, {
            onClose: async () => {
                // Reload Gantt data after modal closes to sync any changes
                await this.loadGanttData();
            }
        });
    }

    onScaleChange(scale) { 
        this.state.scale = scale; 
    }

    navigate(type) {
        // Dispatch a window-level event so the renderer can listen regardless of DOM structure
        const event = new CustomEvent('gantt-navigate', { detail: { type } });
        window.dispatchEvent(event);
    }

    async onGroupByChange(ev) {
        this.state.groupBy = ev.target.value;
        await this.loadGanttData();
    }

    createTask() {
        this.actionService.doAction({
            type: 'ir.actions.act_window',
            res_model: 'project.task',
            views: [[false, 'form']],
            target: 'new',
            context: {
                // Provide Odoo-compatible datetime format without timezone suffix
                default_task_start_date: new Date().toISOString().replace('Z','').replace('T',' ').split('.')[0],
            },
        }, {
            onClose: async () => {
                await this.loadGanttData();
            }
        });
    }

    async refresh() { 
        await this.loadGanttData(); 
    }

    toggleEditable() {
        this.state.editable = !this.state.editable;
    }

    onTaskSelected(ev) {
        // Track selected task from renderer
        this.state.selectedTaskId = ev.detail?.taskId || null;
    }

    async setTaskColor(colorIndex) {
        // Get selected task from the last clicked task
        const taskId = this.state.selectedTaskId;
        
        if (!taskId) {
            this.notification.add("Please click on a task first to select it (task will be highlighted), then choose a color", { 
                type: "warning",
                title: "No Task Selected" 
            });
            return;
        }

        try {
            await this.orm.write(this.props.resModel, [taskId], { color: colorIndex });
            
            const colorNames = ['Purple', 'Red', 'Orange', 'Blue', 'Pink', 'Green', 'Violet', 'Amber'];
            this.notification.add(`Task color changed to ${colorNames[colorIndex] || 'new color'}`, { 
                type: "success" 
            });
            
            await this.loadGanttData();
        } catch (error) {
            this.notification.add("Failed to update task color", { type: "danger" });
            console.error("Color update error:", error);
        }
    }

    exportToCSV() {
        const data = this.state.ganttData;
        if (!data || data.length === 0) {
            this.notification.add("No data to export", { type: "warning" });
            return;
        }

        let csv = "Group,Task Name,Start Date,End Date,Progress,Duration (Days)\n";
        data.forEach(group => {
            group.tasks.forEach(task => {
                const start = new Date(task.start_date).toLocaleDateString();
                const end = new Date(task.end_date).toLocaleDateString();
                const duration = ((new Date(task.end_date) - new Date(task.start_date)) / 86400000).toFixed(1);
                csv += `"${group.name}","${task.name}","${start}","${end}",${task.progress},${duration}\n`;
            });
        });

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `gantt_chart_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        window.URL.revokeObjectURL(url);
    }
}

export class GanttView extends Component {
    static template = "gantt_chart.GanttView";
    static components = { Layout, GanttController };

    setup() {
        this.state = useState({
            groupBy: this.props.context?.group_by?.[0] || 'project_id',
        });
    }

    getControllerProps() {
        return {
            resModel: this.props.resModel,
            domain: this.props.domain,
            context: this.props.context,
            groupBy: this.state.groupBy,
        };
    }
}

export const ganttView = {
    type: "gantt",
    display_name: "Gantt Chart",
    icon: "fa-align-left",  // Better icon that resembles horizontal bars (Gantt-like)
    multiRecord: true,
    searchMenuTypes: ["filter", "groupBy", "favorite"],
    Controller: GanttController,
    Component: GanttView,
    
    props: (genericProps, view) => {
        const { arch, relatedModels, resModel } = genericProps;
        return {
            ...genericProps,
            Model: undefined,
            Renderer: undefined,
            buttonTemplate: arch.getAttribute("button_template") || undefined,
            archInfo: {
                fieldNames: [],
            },
        };
    },
};

registry.category("views").add("gantt", ganttView);