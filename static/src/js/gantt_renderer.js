/** @odoo-module **/

import { Component, onMounted, onWillUnmount, useRef, useState, onWillUpdateProps } from "@odoo/owl";

export class GanttRenderer extends Component {
    static template = "gantt_chart.GanttRenderer";
    static props = {
        data: { type: Array },
        scale: { type: String },
        editable: { type: Boolean, optional: true },
        searchQuery: { type: String, optional: true },
    };

    setup() {
        this.root = useRef("root");
        this.canvasRef = useRef("ganttCanvas");
        this.containerRef = useRef("ganttContainer");
        
        this.state = useState({
            scrollX: 0,
            scrollY: 0,
            draggedTask: null,
            isPanning: false,
            panStartX: 0,
            tooltip: { visible: false, content: '', x: 0, y: 0 },
            hoveredTask: null,
            zoom: 1.0,
            // Selected task for color picker
            selectedTaskId: null,
        });

        // Base dimensions
        this.baseCellWidth = 40;
        this.baseCellHeight = 40;
        this.headerHeight = 80;
        this.sidebarWidth = 250;
        this.minCellWidth = 20;
        this.maxCellWidth = 100;

        this.animationFrame = null;
        this.lastDrawTime = 0;
        this.drawDelay = 16; // ~60fps

        onMounted(() => {
            this.setupCanvas();
            this.drawGantt();
            
            // Store bound handlers for proper cleanup
            this._resizeHandler = this.handleResize.bind(this);
            this._navigateHandler = (e) => this.handleNavigate(e.detail);
            this._keyHandler = (e) => this.handleKey(e);
            
            window.addEventListener('resize', this._resizeHandler);
            window.addEventListener('gantt-navigate', this._navigateHandler);
            window.addEventListener('keydown', this._keyHandler);
            
            // Center view on today initially for better UX
            this.centerOnToday();
        });

        onWillUnmount(() => {
            // Properly remove event listeners using stored references
            if (this._resizeHandler) {
                window.removeEventListener('resize', this._resizeHandler);
            }
            if (this._navigateHandler) {
                window.removeEventListener('gantt-navigate', this._navigateHandler);
            }
            if (this._keyHandler) {
                window.removeEventListener('keydown', this._keyHandler);
            }
            if (this.animationFrame) {
                cancelAnimationFrame(this.animationFrame);
            }
        });

        onWillUpdateProps(() => {
            this.scheduleRedraw();
        });
    }
    formatDateLocal(date) {
        const pad = (n) => String(n).padStart(2, '0');
        const d = date instanceof Date ? date : new Date(date);
        return (
            d.getFullYear() + '-' +
            pad(d.getMonth() + 1) + '-' +
            pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' +
            pad(d.getMinutes()) + ':' +
            pad(d.getSeconds())
        );
    }


    get cellWidth() {
        // Adjust base width per scale for better zooming behavior
        const scale = this.props.scale || 'month';
        const scaleFactor = (
            scale === 'day' ? 2.0 :
            scale === 'week' ? 1.2 :
            scale === 'month' ? 1.0 :
            0.6 // year
        );
        const width = this.baseCellWidth * scaleFactor * this.state.zoom;
        return Math.max(this.minCellWidth, Math.min(this.maxCellWidth, width));
    }

    get cellHeight() {
        return this.baseCellHeight;
    }

    setupCanvas() {
        const canvas = this.canvasRef.el;
        const container = this.containerRef.el;
        if (!canvas || !container) return;

        const rect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
    }

    handleResize() {
        this.setupCanvas();
        this.clampScrollIntoView();
        this.scheduleRedraw();
    }

    scheduleRedraw() {
        const now = Date.now();
        if (now - this.lastDrawTime >= this.drawDelay) {
            this.drawGantt();
            this.lastDrawTime = now;
        } else if (!this.animationFrame) {
            this.animationFrame = requestAnimationFrame(() => {
                this.animationFrame = null;
                this.drawGantt();
                this.lastDrawTime = Date.now();
            });
        }
    }

    drawGantt() {
        const canvas = this.canvasRef.el;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const data = this.props.data;
        const rect = canvas.getBoundingClientRect();
        
        ctx.clearRect(0, 0, rect.width, rect.height);

        if (!data || data.length === 0) {
            this.drawEmptyState(ctx, rect);
            return;
        }

        const dates = this.calculateDateRange(data);
        if (!dates.start || !dates.end) {
            this.drawEmptyState(ctx, rect);
            return;
        }

        // Draw in layers for better visual hierarchy
        this.drawGrid(ctx, dates, data, rect);
        this.drawTasks(ctx, data, dates, rect);
        this.drawTodayMarker(ctx, dates, rect);  // Draw TODAY marker AFTER tasks so it's on top
        this.drawHeader(ctx, dates, rect);
        this.drawSidebar(ctx, data, rect);
    }

    getMaxScrollX(rect, dates) {
        // total content width minus viewport
        const scale = this.props.scale || 'month';
        let totalUnits = 0;
        if (scale === 'week') {
            const days = Math.ceil((dates.end - dates.start) / 86400000);
            totalUnits = Math.ceil(days / 7);
        } else if (scale === 'month') {
            // Month view renders per day, so use number of days
            const days = Math.ceil((dates.end - dates.start) / 86400000);
            totalUnits = days;
        } else {
            const months = (dates.end.getFullYear() - dates.start.getFullYear()) * 12 + (dates.end.getMonth() - dates.start.getMonth()) + 1;
            totalUnits = months;
        }
        const contentWidth = this.sidebarWidth + totalUnits * this.cellWidth;
        const viewportWidth = rect.width;
        return Math.max(0, contentWidth - viewportWidth);
    }

    clampScrollIntoView() {
        const canvas = this.canvasRef.el;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const data = this.props.data || [];
        const dates = this.calculateDateRange(data);
        const maxX = this.getMaxScrollX(rect, dates);
        this.state.scrollX = Math.max(0, Math.min(this.state.scrollX, maxX));
        this.state.scrollY = Math.max(0, this.state.scrollY);
    }

    centerOnToday() {
        const canvas = this.canvasRef.el;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const data = this.props.data || [];
        const dates = this.calculateDateRange(data);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        // Use the same dateToX calculation to ensure consistency
        const xToday = this.dateToX(today, dates) + this.state.scrollX;
        const centerX = this.sidebarWidth + (rect.width - this.sidebarWidth) / 2;
        this.state.scrollX = Math.max(0, xToday - centerX);
        this.clampScrollIntoView();
        this.scheduleRedraw();
    }

    drawEmptyState(ctx, rect) {
        ctx.font = '16px Arial';
        ctx.fillStyle = '#aaa';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('No tasks with start and end dates to display.', rect.width / 2, rect.height / 2);
    }

    calculateDateRange(data) {
        let minDate, maxDate;
        
        data.forEach(g => g.tasks.forEach(t => {
            const start = new Date(t.start_date);
            const end = new Date(t.end_date);
            if (!minDate || start < minDate) minDate = start;
            if (!maxDate || end > maxDate) maxDate = end;
        }));

        if (!minDate || !maxDate) {
            // If no tasks, show current month with some padding
            const today = new Date();
            minDate = new Date(today.getFullYear(), today.getMonth() - 6, 1);
            maxDate = new Date(today.getFullYear(), today.getMonth() + 18, 0);
            return { start: minDate, end: maxDate };
        }

        // Add much more padding to date range for better navigation
        minDate = new Date(minDate.getFullYear(), minDate.getMonth() - 12, 1);
        maxDate = new Date(maxDate.getFullYear(), maxDate.getMonth() + 24, 0);

        return { start: minDate, end: maxDate };
    }

    drawGrid(ctx, dates, data, rect) {
        const days = Math.ceil((dates.end - dates.start) / 86400000);
        const scale = this.props.scale || 'month';

        // Vertical grid lines (dates) with scale support
        if (scale === 'day' || scale === 'month') {
            for (let i = 0; i <= days; i++) {
                const x = this.sidebarWidth + i * this.cellWidth - this.state.scrollX;
                if (x >= this.sidebarWidth && x <= rect.width) {
                    // Subtle gradient for vertical lines
                    const lineGradient = ctx.createLinearGradient(0, this.headerHeight, 0, rect.height);
                    lineGradient.addColorStop(0, 'rgba(226, 232, 240, 0.8)');
                    lineGradient.addColorStop(0.5, 'rgba(226, 232, 240, 0.5)');
                    lineGradient.addColorStop(1, 'rgba(226, 232, 240, 0.2)');
                    ctx.strokeStyle = lineGradient;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(x, this.headerHeight);
                    ctx.lineTo(x, rect.height);
                    ctx.stroke();
                }
            }
        } else if (scale === 'week') {
            let current = new Date(dates.start);
            current.setDate(current.getDate() - current.getDay());
            while (current <= dates.end) {
                const x = this.dateToX(current, dates);
                if (x >= this.sidebarWidth && x <= rect.width) {
                    ctx.strokeStyle = 'rgba(226, 232, 240, 0.6)';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(x, this.headerHeight);
                    ctx.lineTo(x, rect.height);
                    ctx.stroke();
                }
                current.setDate(current.getDate() + 7);
            }
        } else if (scale === 'year') {
            let current = new Date(dates.start.getFullYear(), dates.start.getMonth(), 1);
            while (current <= dates.end) {
                const x = this.dateToX(current, dates);
                if (x >= this.sidebarWidth && x <= rect.width) {
                    ctx.strokeStyle = 'rgba(226, 232, 240, 0.6)';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(x, this.headerHeight);
                    ctx.lineTo(x, rect.height);
                    ctx.stroke();
                }
                current.setMonth(current.getMonth() + 1);
            }
        }

        // Horizontal grid lines (tasks) with subtle styling
        let totalRows = data.reduce((acc, g) => acc + Math.max(g.tasks.length, 1), 0);
        for (let i = 0; i <= totalRows; i++) {
            const y = this.headerHeight + i * this.cellHeight - this.state.scrollY;
            if (y >= this.headerHeight && y <= rect.height) {
                // Alternate row backgrounds
                if (i % 2 === 1) {
                    ctx.fillStyle = 'rgba(248, 250, 252, 0.5)';
                    ctx.fillRect(this.sidebarWidth, y, rect.width - this.sidebarWidth, this.cellHeight);
                }
                
                // Grid line
                const hLineGradient = ctx.createLinearGradient(this.sidebarWidth, 0, rect.width, 0);
                hLineGradient.addColorStop(0, 'rgba(226, 232, 240, 0.6)');
                hLineGradient.addColorStop(0.5, 'rgba(226, 232, 240, 0.4)');
                hLineGradient.addColorStop(1, 'rgba(226, 232, 240, 0.2)');
                ctx.strokeStyle = hLineGradient;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(this.sidebarWidth, y);
                ctx.lineTo(rect.width, y);
                ctx.stroke();
            }
        }
    }

    drawTodayMarker(ctx, dates, rect) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        if (today >= dates.start && today <= dates.end) {
            const x = this.dateToX(today, dates);
            if (x >= this.sidebarWidth && x <= rect.width) {
                ctx.save();
                
                // Glow effect behind the line
                ctx.strokeStyle = 'rgba(239, 68, 68, 0.15)';
                ctx.lineWidth = 8;
                ctx.beginPath();
                ctx.moveTo(x, this.headerHeight);
                ctx.lineTo(x, rect.height);
                ctx.stroke();
                
                // Secondary glow
                ctx.strokeStyle = 'rgba(239, 68, 68, 0.25)';
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.moveTo(x, this.headerHeight);
                ctx.lineTo(x, rect.height);
                ctx.stroke();
                
                // Main gradient line
                const todayGradient = ctx.createLinearGradient(0, this.headerHeight, 0, rect.height);
                todayGradient.addColorStop(0, '#ef4444');
                todayGradient.addColorStop(0.5, '#f87171');
                todayGradient.addColorStop(1, '#ef4444');
                ctx.strokeStyle = todayGradient;
                ctx.lineWidth = 2;
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                ctx.moveTo(x, this.headerHeight);
                ctx.lineTo(x, rect.height);
                ctx.stroke();
                ctx.setLineDash([]);
                
                // Today indicator badge - positioned in the HEADER area so it's never covered
                const badgeWidth = 55;
                const badgeHeight = 22;
                const badgeX = x - badgeWidth / 2;
                const badgeY = this.headerHeight - badgeHeight - 8;  // Place ABOVE the grid line, in header
                
                // Badge shadow
                ctx.shadowColor = 'rgba(239, 68, 68, 0.4)';
                ctx.shadowBlur = 10;
                ctx.shadowOffsetY = 2;
                
                // Badge background with gradient
                const badgeGradient = ctx.createLinearGradient(badgeX, badgeY, badgeX, badgeY + badgeHeight);
                badgeGradient.addColorStop(0, '#ef4444');
                badgeGradient.addColorStop(1, '#dc2626');
                ctx.fillStyle = badgeGradient;
                this.roundRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, 10, true, false);
                
                ctx.shadowColor = 'transparent';
                ctx.shadowBlur = 0;
                
                // Badge text
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 10px Inter, Arial, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('TODAY', x, badgeY + badgeHeight / 2);
                ctx.textAlign = 'left';
                
                ctx.restore();
            }
        }
    }

    drawHeader(ctx, dates, rect) {
        // Gradient background
        const headerGradient = ctx.createLinearGradient(0, 0, 0, this.headerHeight);
        headerGradient.addColorStop(0, '#ffffff');
        headerGradient.addColorStop(1, '#f8fafc');
        ctx.fillStyle = headerGradient;
        ctx.fillRect(0, 0, rect.width, this.headerHeight);
        
        // Subtle shadow line at bottom
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, this.headerHeight);
        ctx.lineTo(rect.width, this.headerHeight);
        ctx.stroke();
        
        // Gradient accent line
        const accentGradient = ctx.createLinearGradient(0, 0, rect.width, 0);
        accentGradient.addColorStop(0, '#6366f1');
        accentGradient.addColorStop(0.5, '#06b6d4');
        accentGradient.addColorStop(1, '#10b981');
        ctx.strokeStyle = accentGradient;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, this.headerHeight - 1);
        ctx.lineTo(rect.width, this.headerHeight - 1);
        ctx.stroke();

        ctx.save();
        ctx.beginPath();
        ctx.rect(this.sidebarWidth, 0, rect.width - this.sidebarWidth, this.headerHeight);
        ctx.clip();

        // Draw header according to scale
        ctx.fillStyle = '#1e293b';
        ctx.font = 'bold 13px Inter, Arial, sans-serif';
        ctx.textBaseline = 'top';
        const scale = this.props.scale || 'month';
        
        if (scale === 'day') {
            let current = new Date(dates.start);
            while (current <= dates.end) {
                const monthX = this.dateToX(new Date(current.getFullYear(), current.getMonth(), 1), dates);
                const monthName = current.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                ctx.fillStyle = '#1e293b';
                ctx.font = 'bold 13px Inter, Arial, sans-serif';
                ctx.fillText(monthName, Math.max(this.sidebarWidth + 8, monthX + 8), 12);
                current.setMonth(current.getMonth() + 1);
            }
            ctx.font = '11px Inter, Arial, sans-serif';
            let dayCounter = new Date(dates.start);
            const days = Math.ceil((dates.end - dates.start) / 86400000);
            for (let i = 0; i <= days; i++) {
                const dayX = this.dateToX(dayCounter, dates);
                const isWeekend = dayCounter.getDay() === 0 || dayCounter.getDay() === 6;
                const day = dayCounter.getDate();
                const dayOfWeek = dayCounter.toLocaleDateString('en-US', { weekday: 'short' });
                
                ctx.fillStyle = isWeekend ? '#ef4444' : '#64748b';
                ctx.fillText(day.toString(), dayX + 5, 42);
                ctx.fillStyle = isWeekend ? '#fca5a5' : '#94a3b8';
                ctx.font = '10px Inter, Arial, sans-serif';
                ctx.fillText(dayOfWeek, dayX + 5, 58);
                ctx.font = '11px Inter, Arial, sans-serif';
                dayCounter.setDate(dayCounter.getDate() + 1);
            }
        } else if (scale === 'week') {
            let current = new Date(dates.start);
            while (current <= dates.end) {
                const monthX = this.dateToX(new Date(current.getFullYear(), current.getMonth(), 1), dates);
                const monthName = current.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                if (monthX >= this.sidebarWidth && monthX <= rect.width) {
                    ctx.fillStyle = '#1e293b';
                    ctx.font = 'bold 13px Inter, Arial, sans-serif';
                    ctx.fillText(monthName, Math.max(this.sidebarWidth + 8, monthX + 8), 12);
                }
                current.setMonth(current.getMonth() + 1);
            }
            ctx.font = '11px Inter, Arial, sans-serif';
            ctx.fillStyle = '#64748b';
            let weekStart = new Date(dates.start);
            weekStart.setDate(weekStart.getDate() - weekStart.getDay());
            while (weekStart <= dates.end) {
                const weekX = this.dateToX(weekStart, dates);
                const weekLabel = `W${this.getWeekNumber(weekStart)}`;
                ctx.fillText(weekLabel, weekX + 5, 48);
                weekStart.setDate(weekStart.getDate() + 7);
            }
        } else if (scale === 'month') {
            let current = new Date(dates.start);
            while (current <= dates.end) {
                const monthX = this.dateToX(new Date(current.getFullYear(), current.getMonth(), 1), dates);
                const monthName = current.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                if (monthX >= this.sidebarWidth && monthX <= rect.width) {
                    ctx.fillStyle = '#1e293b';
                    ctx.font = 'bold 13px Inter, Arial, sans-serif';
                    ctx.fillText(monthName, Math.max(this.sidebarWidth + 8, monthX + 8), 12);
                }
                current.setMonth(current.getMonth() + 1);
            }
            ctx.font = '11px Inter, Arial, sans-serif';
            let dayCounter = new Date(dates.start);
            const days = Math.ceil((dates.end - dates.start) / 86400000);
            for (let i = 0; i <= days; i++) {
                const dayX = this.dateToX(dayCounter, dates);
                const isWeekend = dayCounter.getDay() === 0 || dayCounter.getDay() === 6;
                
                // Weekend highlighting with gradient
                if (isWeekend) {
                    const weekendGradient = ctx.createLinearGradient(dayX, this.headerHeight, dayX, rect.height);
                    weekendGradient.addColorStop(0, 'rgba(241, 245, 249, 0.8)');
                    weekendGradient.addColorStop(1, 'rgba(241, 245, 249, 0.4)');
                    ctx.fillStyle = weekendGradient;
                    ctx.fillRect(dayX, this.headerHeight, this.cellWidth, rect.height - this.headerHeight);
                }
                
                const day = dayCounter.getDate();
                ctx.fillStyle = isWeekend ? '#ef4444' : '#64748b';
                ctx.fillText(day.toString(), dayX + 5, 48);
                dayCounter.setDate(dayCounter.getDate() + 1);
            }
        } else if (scale === 'year') {
            let currentYear = dates.start.getFullYear();
            while (currentYear <= dates.end.getFullYear()) {
                const yearX = this.dateToX(new Date(currentYear, 0, 1), dates);
                if (yearX >= this.sidebarWidth && yearX <= rect.width) {
                    ctx.fillStyle = '#1e293b';
                    ctx.font = 'bold 14px Inter, Arial, sans-serif';
                    ctx.fillText(String(currentYear), Math.max(this.sidebarWidth + 8, yearX + 8), 12);
                }
                currentYear++;
            }
            ctx.font = '11px Inter, Arial, sans-serif';
            ctx.fillStyle = '#64748b';
            let current = new Date(dates.start.getFullYear(), dates.start.getMonth(), 1);
            while (current <= dates.end) {
                const monthX = this.dateToX(current, dates);
                const monthName = current.toLocaleDateString('en-US', { month: 'short' });
                ctx.fillText(monthName, monthX + 5, 48);
                current.setMonth(current.getMonth() + 1);
            }
        }

        ctx.restore();
    }

    drawSidebar(ctx, data, rect) {
        // Gradient background
        const sidebarGradient = ctx.createLinearGradient(0, 0, this.sidebarWidth, 0);
        sidebarGradient.addColorStop(0, '#ffffff');
        sidebarGradient.addColorStop(1, '#f8fafc');
        ctx.fillStyle = sidebarGradient;
        ctx.fillRect(0, this.headerHeight, this.sidebarWidth, rect.height);
        
        // Right border with subtle shadow effect
        const borderGradient = ctx.createLinearGradient(this.sidebarWidth - 3, 0, this.sidebarWidth, 0);
        borderGradient.addColorStop(0, 'transparent');
        borderGradient.addColorStop(1, 'rgba(0, 0, 0, 0.05)');
        ctx.fillStyle = borderGradient;
        ctx.fillRect(this.sidebarWidth - 3, this.headerHeight, 3, rect.height);
        
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.sidebarWidth, 0);
        ctx.lineTo(this.sidebarWidth, rect.height);
        ctx.stroke();

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, this.headerHeight, this.sidebarWidth, rect.height - this.headerHeight);
        ctx.clip();

        ctx.fillStyle = '#1e293b';
        ctx.font = '600 12px Inter, Arial, sans-serif';
        ctx.textBaseline = 'middle';
        
        let y = this.headerHeight - this.state.scrollY;
        
        // Store group positions for click detection
        this._groupPositions = [];
        
        data.forEach((group, index) => {
            const isCollapsed = group.isCollapsed || false;
            const taskCount = isCollapsed ? 1 : Math.max(group.tasks.length, 1);
            const groupHeight = taskCount * this.cellHeight;
            const textY = y + groupHeight / 2;
            
            // Store group position for click detection
            this._groupPositions.push({
                id: group.id,
                y: y,
                height: groupHeight,
                isCollapsed: isCollapsed
            });
            
            if (y + groupHeight > this.headerHeight && y < rect.height) {
                // Enhanced group background with gradient
                if (isCollapsed) {
                    const collapsedGradient = ctx.createLinearGradient(0, y, this.sidebarWidth, y);
                    collapsedGradient.addColorStop(0, 'rgba(99, 102, 241, 0.12)');
                    collapsedGradient.addColorStop(1, 'rgba(99, 102, 241, 0.04)');
                    ctx.fillStyle = collapsedGradient;
                } else {
                    // Alternating subtle backgrounds
                    const altGradient = ctx.createLinearGradient(0, y, this.sidebarWidth, y);
                    const bgOpacity = index % 2 === 0 ? 0.02 : 0.04;
                    altGradient.addColorStop(0, `rgba(0, 0, 0, ${bgOpacity})`);
                    altGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
                    ctx.fillStyle = altGradient;
                }
                ctx.fillRect(0, Math.max(y, this.headerHeight), this.sidebarWidth, Math.min(groupHeight, rect.height - y));
                
                // Collapse/Expand icon with animation-like styling
                const iconSize = 16;
                const iconX = 10;
                const iconY = textY - iconSize / 2;
                
                // Icon background circle
                ctx.beginPath();
                ctx.arc(iconX + iconSize / 2, textY, iconSize / 2 + 2, 0, Math.PI * 2);
                ctx.fillStyle = isCollapsed ? 'rgba(99, 102, 241, 0.15)' : 'rgba(100, 116, 139, 0.1)';
                ctx.fill();
                
                // Icon
                ctx.fillStyle = isCollapsed ? '#6366f1' : '#64748b';
                ctx.font = '10px Arial, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const icon = isCollapsed ? '▶' : '▼';
                ctx.fillText(icon, iconX + iconSize / 2, textY);
                ctx.textAlign = 'left';
                
                // Group name with enhanced styling
                ctx.fillStyle = isCollapsed ? '#4f46e5' : '#1e293b';
                ctx.font = isCollapsed ? 'bold 12px Inter, Arial, sans-serif' : '600 12px Inter, Arial, sans-serif';
                const groupText = isCollapsed 
                    ? `${group.name} (${group.tasks?.length || 0} hidden)`
                    : `${group.name} (${group.tasks.length})`;
                const truncated = this.truncateText(ctx, groupText, this.sidebarWidth - 45);
                ctx.fillText(truncated, 32, textY);
                
                // Task count badge for expanded groups
                if (!isCollapsed && group.tasks.length > 0) {
                    const badgeText = group.tasks.length.toString();
                    ctx.font = 'bold 9px Inter, Arial, sans-serif';
                    const badgeWidth = ctx.measureText(badgeText).width + 10;
                    const badgeX = this.sidebarWidth - badgeWidth - 8;
                    const badgeY = textY - 8;
                    
                    // Badge background
                    ctx.fillStyle = 'rgba(99, 102, 241, 0.15)';
                    this.roundRect(ctx, badgeX, badgeY, badgeWidth, 16, 8, true, false);
                    
                    // Badge text
                    ctx.fillStyle = '#6366f1';
                    ctx.textAlign = 'center';
                    ctx.fillText(badgeText, badgeX + badgeWidth / 2, textY);
                    ctx.textAlign = 'left';
                }
                
                // Separator line with gradient
                const lineGradient = ctx.createLinearGradient(0, 0, this.sidebarWidth, 0);
                lineGradient.addColorStop(0, '#e2e8f0');
                lineGradient.addColorStop(1, 'rgba(226, 232, 240, 0.3)');
                ctx.strokeStyle = lineGradient;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(8, y + groupHeight);
                ctx.lineTo(this.sidebarWidth - 8, y + groupHeight);
                ctx.stroke();
            }
            
            y += groupHeight;
        });

        ctx.restore();
    }

    drawTasks(ctx, data, dates, rect) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(this.sidebarWidth, this.headerHeight, rect.width - this.sidebarWidth, rect.height - this.headerHeight);
        ctx.clip();

        let taskRow = 0;
        
        data.forEach(group => {
            if (group.tasks.length === 0) {
                taskRow++;
                return;
            }
            
            group.tasks.forEach(task => {
                const start = new Date(task.start_date);
                const end = new Date(task.end_date);
                
                // If end time is exactly midnight (00:00:00), treat it as end of previous day
                if (end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0) {
                    end.setDate(end.getDate() - 1);
                    end.setHours(23, 59, 59, 999);
                }
                
                const startX = this.dateToX(start, dates);
                const endX = this.dateToX(end, dates);
                const width = Math.max(endX - startX, 8);
                const y = this.headerHeight + (taskRow * this.cellHeight) + 5 - this.state.scrollY;
                const height = this.cellHeight - 10;

                if (y + this.cellHeight > this.headerHeight && y < rect.height) {
                    const isHovered = this.state.hoveredTask?.id === task.id;
                    const isDragged = this.state.draggedTask?.id === task.id;
                    const isSelected = this.state.selectedTaskId === task.id;
                    const taskColor = this.getTaskColor(task);
                    
                    // Enhanced shadow effects
                    if (isSelected) {
                        // Glow effect for selected
                        ctx.shadowColor = 'rgba(99, 102, 241, 0.6)';
                        ctx.shadowBlur = 20;
                        ctx.shadowOffsetY = 0;
                        ctx.shadowOffsetX = 0;
                    } else if (isHovered || isDragged) {
                        // Lift shadow for hovered
                        ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
                        ctx.shadowBlur = 15;
                        ctx.shadowOffsetY = 6;
                        ctx.shadowOffsetX = 0;
                    } else {
                        // Subtle shadow for normal state
                        ctx.shadowColor = 'rgba(0, 0, 0, 0.15)';
                        ctx.shadowBlur = 6;
                        ctx.shadowOffsetY = 2;
                        ctx.shadowOffsetX = 0;
                    }
                    
                    // Apply opacity for dragged state
                    if (isDragged) {
                        ctx.globalAlpha = 0.85;
                    }
                    
                    // Draw task bar with gradient
                    ctx.fillStyle = this.createTaskGradient(ctx, startX, y, width, height, taskColor);
                    this.roundRect(ctx, startX, y, width, height, 8, true, false);
                    
                    // Reset shadow for subsequent draws
                    ctx.shadowColor = 'transparent';
                    ctx.shadowBlur = 0;
                    ctx.shadowOffsetY = 0;
                    ctx.shadowOffsetX = 0;
                    
                    // Add shine effect on top
                    ctx.fillStyle = this.createShineGradient(ctx, startX, y, width, height);
                    this.roundRect(ctx, startX, y, width, height * 0.5, 8, true, false);
                    
                    // Selection ring with animated glow effect
                    if (isSelected) {
                        ctx.strokeStyle = '#6366f1';
                        ctx.lineWidth = 3;
                        ctx.setLineDash([]);
                        this.roundRect(ctx, startX - 3, y - 3, width + 6, height + 6, 10, false, true);
                        
                        // Inner glow ring
                        ctx.strokeStyle = 'rgba(99, 102, 241, 0.4)';
                        ctx.lineWidth = 6;
                        this.roundRect(ctx, startX - 5, y - 5, width + 10, height + 10, 12, false, true);
                    }
                    
                    // Hover ring
                    if (isHovered && !isSelected) {
                        ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
                        ctx.lineWidth = 2;
                        this.roundRect(ctx, startX, y, width, height, 8, false, true);
                    }
                    
                    // Enhanced progress bar with gradient
                    if (task.progress > 0) {
                        const progressWidth = Math.max((width - 6) * (task.progress / 100), 4);
                        const progressGradient = ctx.createLinearGradient(startX + 3, 0, startX + 3 + progressWidth, 0);
                        progressGradient.addColorStop(0, 'rgba(255, 255, 255, 0.35)');
                        progressGradient.addColorStop(1, 'rgba(255, 255, 255, 0.15)');
                        ctx.fillStyle = progressGradient;
                        this.roundRect(ctx, startX + 3, y + height - 6, progressWidth, 4, 2, true, false);
                        
                        // Progress bar border
                        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
                        ctx.lineWidth = 0.5;
                        this.roundRect(ctx, startX + 3, y + height - 6, progressWidth, 4, 2, false, true);
                    }
                    
                    // Task name with text shadow for better readability
                    if (width > 45) {
                        // Text shadow
                        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
                        ctx.font = (isHovered || isSelected) ? 'bold 11px Inter, Arial, sans-serif' : '600 11px Inter, Arial, sans-serif';
                        ctx.textBaseline = 'middle';
                        const taskText = this.truncateText(ctx, task.name, width - 16);
                        ctx.fillText(taskText, startX + 9, y + height / 2 + 1);
                        
                        // Main text
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(taskText, startX + 8, y + height / 2);
                    }
                    
                    ctx.globalAlpha = 1.0;
                    
                    // Enhanced resize handles with glow
                    if ((isHovered || isSelected) && this.props.editable) {
                        const handleRadius = isSelected ? 5 : 4;
                        const handleColor = isSelected ? '#6366f1' : taskColor.main;
                        
                        // Left handle
                        ctx.beginPath();
                        ctx.arc(startX + 6, y + height / 2, handleRadius + 2, 0, Math.PI * 2);
                        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                        ctx.fill();
                        
                        ctx.beginPath();
                        ctx.arc(startX + 6, y + height / 2, handleRadius, 0, Math.PI * 2);
                        ctx.fillStyle = handleColor;
                        ctx.fill();
                        
                        // Right handle
                        ctx.beginPath();
                        ctx.arc(startX + width - 6, y + height / 2, handleRadius + 2, 0, Math.PI * 2);
                        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                        ctx.fill();
                        
                        ctx.beginPath();
                        ctx.arc(startX + width - 6, y + height / 2, handleRadius, 0, Math.PI * 2);
                        ctx.fillStyle = handleColor;
                        ctx.fill();
                        
                        // Handle arrows/icons
                        ctx.fillStyle = '#ffffff';
                        ctx.font = '8px Arial';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText('◀', startX + 6, y + height / 2);
                        ctx.fillText('▶', startX + width - 6, y + height / 2);
                        ctx.textAlign = 'left';
                    }
                }
                
                task._rect = { x: startX, y, width, height };
                taskRow++;
            });
        });

        ctx.restore();
    }

    roundRect(ctx, x, y, width, height, radius, fill, stroke) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
        
        if (fill) ctx.fill();
        if (stroke) ctx.stroke();
    }

    truncateText(ctx, text, maxWidth) {
        const width = ctx.measureText(text).width;
        if (width <= maxWidth) return text;
        
        const ellipsis = '...';
        const ellipsisWidth = ctx.measureText(ellipsis).width;
        let truncated = text;
        
        while (ctx.measureText(truncated).width + ellipsisWidth > maxWidth && truncated.length > 0) {
            truncated = truncated.slice(0, -1);
        }
        
        return truncated + ellipsis;
    }

    // Enhanced color palette with gradient pairs
    getTaskColors() {
        return [
            { main: '#6366f1', light: '#818cf8', dark: '#4f46e5' }, // Indigo
            { main: '#ef4444', light: '#f87171', dark: '#dc2626' }, // Red
            { main: '#f59e0b', light: '#fbbf24', dark: '#d97706' }, // Amber
            { main: '#06b6d4', light: '#22d3ee', dark: '#0891b2' }, // Cyan
            { main: '#ec4899', light: '#f472b6', dark: '#db2777' }, // Pink
            { main: '#10b981', light: '#34d399', dark: '#059669' }, // Emerald
            { main: '#8b5cf6', light: '#a78bfa', dark: '#7c3aed' }, // Violet
            { main: '#f97316', light: '#fb923c', dark: '#ea580c' }, // Orange
        ];
    }

    getTaskColor(task) {
        const colors = this.getTaskColors();
        return colors[task.color % colors.length] || colors[0];
    }

    // Create gradient for task bars
    createTaskGradient(ctx, x, y, width, height, colorObj) {
        const gradient = ctx.createLinearGradient(x, y, x, y + height);
        gradient.addColorStop(0, colorObj.light);
        gradient.addColorStop(0.5, colorObj.main);
        gradient.addColorStop(1, colorObj.dark);
        return gradient;
    }

    // Create subtle shine effect
    createShineGradient(ctx, x, y, width, height) {
        const gradient = ctx.createLinearGradient(x, y, x, y + height * 0.5);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 0.3)');
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
        return gradient;
    }

    getTaskAt(x, y) {
        for (const group of this.props.data) {
            for (const task of group.tasks) {
                if (task._rect && 
                    x >= task._rect.x && 
                    x <= task._rect.x + task._rect.width &&
                    y >= task._rect.y && 
                    y <= task._rect.y + task._rect.height) {
                    return task;
                }
            }
        }
        return null;
    }

    dateToX(date, dates) {
        const scale = this.props.scale || 'month';
        // Ensure we're working with local dates to avoid timezone issues
        const localDate = new Date(date.getTime() - (date.getTimezoneOffset() * 60000));
        const localStart = new Date(dates.start.getTime() - (dates.start.getTimezoneOffset() * 60000));
        
        const days = (localDate - localStart) / 86400000;
        if (scale === 'day' || scale === 'month') {
            return this.sidebarWidth + days * this.cellWidth - this.state.scrollX;
        } else if (scale === 'week') {
            const weeks = days / 7.0;
            return this.sidebarWidth + weeks * this.cellWidth - this.state.scrollX;
        } else {
            // year: months resolution
            const months = (localDate.getFullYear() - localStart.getFullYear()) * 12 + (localDate.getMonth() - localStart.getMonth()) + (localDate.getDate()-1)/30;
            return this.sidebarWidth + months * this.cellWidth - this.state.scrollX;
        }
    }

    xToDate(x, dates) {
        const scale = this.props.scale || 'month';
        // Ensure we're working with local dates to avoid timezone issues
        const localStart = new Date(dates.start.getTime() - (dates.start.getTimezoneOffset() * 60000));
        
        if (scale === 'day' || scale === 'month') {
            const days = (x - this.sidebarWidth + this.state.scrollX) / this.cellWidth;
            const result = new Date(localStart.getTime() + days * 86400000);
            // Convert back to local timezone
            return new Date(result.getTime() + (result.getTimezoneOffset() * 60000));
        } else if (scale === 'week') {
            const weeks = (x - this.sidebarWidth + this.state.scrollX) / this.cellWidth;
            const days = weeks * 7.0;
            const result = new Date(localStart.getTime() + days * 86400000);
            return new Date(result.getTime() + (result.getTimezoneOffset() * 60000));
        } else {
            // year scale
            const months = (x - this.sidebarWidth + this.state.scrollX) / this.cellWidth;
            const start = new Date(localStart.getFullYear(), localStart.getMonth(), 1);
            start.setMonth(start.getMonth() + months);
            return new Date(start.getTime() + (start.getTimezoneOffset() * 60000));
        }
    }

    dispatchEvent(name, detail) {
        this.root.el.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
    }

    onMouseDown(e) {
        const rect = this.canvasRef.el.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        // Check if click is in sidebar for group collapse toggle
        if (x < this.sidebarWidth && y > this.headerHeight && this._groupPositions) {
            const scrolledY = y + this.state.scrollY;
            for (const groupPos of this._groupPositions) {
                if (scrolledY >= groupPos.y && scrolledY < groupPos.y + groupPos.height) {
                    // Clicked on a group - toggle collapse
                    this.dispatchEvent('toggle-group', { groupId: groupPos.id });
                    return;
                }
            }
        }
        
        const task = this.getTaskAt(x, y);
        
        // Store click position for detecting single click vs drag
        this._mouseDownPos = { x: e.clientX, y: e.clientY, task };
        
        if (this.props.editable && task) {
            this.state.draggedTask = {
                ...task,
                startX: e.clientX,
                originalStart: new Date(task.start_date),
                originalEnd: new Date(task.end_date),
            };
            this.state.tooltip.visible = false;
            this.canvasRef.el.style.cursor = 'grabbing';
        } else if (!task) {
            // begin panning when clicking empty area
            this.state.isPanning = true;
            this.state.panStartX = e.clientX;
            this.canvasRef.el.style.cursor = 'grabbing';
        }
    }

    onMouseMove(e) {
        const rect = this.canvasRef.el.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (this.state.draggedTask) {
            const deltaX = e.clientX - this.state.draggedTask.startX;
            const daysDelta = Math.round(deltaX / this.cellWidth);
            const msDelta = daysDelta * 86400000;
            
            const newStartDate = new Date(this.state.draggedTask.originalStart.getTime() + msDelta);
            const newEndDate = new Date(this.state.draggedTask.originalEnd.getTime() + msDelta);
            
            const taskInUI = this.props.data
                .flatMap(g => g.tasks)
                .find(t => t.id === this.state.draggedTask.id);
            
            if (taskInUI) {
                // Format dates consistently in local time for Odoo
                taskInUI.start_date = this.formatDateLocal(newStartDate);
                taskInUI.end_date = this.formatDateLocal(newEndDate);
                this.scheduleRedraw();
            }
        } else if (this.state.isPanning) {
            const dx = e.clientX - this.state.panStartX;
            this.state.panStartX = e.clientX;
            this.state.scrollX -= dx;
            this.clampScrollIntoView();
            this.scheduleRedraw();
        } else {
            const task = this.getTaskAt(x, y);
            this.state.hoveredTask = task;
            
            if (task) {
                const startDate = new Date(task.start_date).toLocaleDateString();
                const endDate = new Date(task.end_date).toLocaleDateString();
                const duration = ((new Date(task.end_date) - new Date(task.start_date)) / 86400000).toFixed(1);
                
                this.state.tooltip = {
                    visible: true,
                    content: `${task.name}\nStart: ${startDate}\nEnd: ${endDate}\nDuration: ${duration} days\nProgress: ${task.progress}%`,
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top,
                };
                
                // Show grab cursor only if editable, otherwise show pointer
                if (this.props.editable) {
                    this.canvasRef.el.style.cursor = 'grab';
                } else {
                    this.canvasRef.el.style.cursor = 'pointer';
                }
            } else {
                this.state.tooltip.visible = false;
                this.canvasRef.el.style.cursor = 'default';
            }
            
            this.scheduleRedraw();
        }
    }

    onMouseUp(e) {
        // Check if this was a click (not a drag) to select task for color picker
        const wasDragging = this.state.draggedTask && this._mouseDownPos;
        const dragDistance = this._mouseDownPos ? 
            Math.sqrt(Math.pow(e.clientX - this._mouseDownPos.x, 2) + Math.pow(e.clientY - this._mouseDownPos.y, 2)) : 0;
        const wasClick = dragDistance < 5; // Less than 5 pixels = click
        
        if (this.state.draggedTask) {
            const task = this.props.data
                .flatMap(g => g.tasks)
                .find(t => t.id === this.state.draggedTask.id);
            
            if (task && !wasClick) {
                // Only dispatch update if actually dragged
                this.dispatchEvent('task-updated', {
                    taskId: task.id,
                    startDate: task.start_date,
                    endDate: task.end_date,
                });
            }
            
            this.state.draggedTask = null;
            this.canvasRef.el.style.cursor = 'default';
        } else if (this.state.isPanning) {
            this.state.isPanning = false;
            this.canvasRef.el.style.cursor = 'default';
        }
        
        // Handle single click for task selection (for color picker)
        if (wasClick && this._mouseDownPos?.task) {
            const clickedTask = this._mouseDownPos.task;
            // Toggle selection: if already selected, deselect; otherwise select
            if (this.state.selectedTaskId === clickedTask.id) {
                this.state.selectedTaskId = null;
            } else {
                this.state.selectedTaskId = clickedTask.id;
            }
            // Dispatch event to controller
            this.dispatchEvent('task-selected', { taskId: this.state.selectedTaskId });
            this.scheduleRedraw();
        } else if (wasClick && !this._mouseDownPos?.task) {
            // Clicked on empty area - deselect
            if (this.state.selectedTaskId) {
                this.state.selectedTaskId = null;
                this.dispatchEvent('task-selected', { taskId: null });
                this.scheduleRedraw();
            }
        }
        
        this._mouseDownPos = null;
    }

    onDoubleClick(e) {
        const rect = this.canvasRef.el.getBoundingClientRect();
        const task = this.getTaskAt(e.clientX - rect.left, e.clientY - rect.top);
        
        if (task) {
            this.dispatchEvent('task-clicked', { taskId: task.id });
        }
    }

    getWeekNumber(date) {
        const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const dayNum = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
        return Math.ceil((((d - yearStart) / 86400000) + 1)/7);
    }

    onWheel(e) {
        e.preventDefault();
        
        if (e.ctrlKey || e.metaKey) {
            // Ctrl/Cmd + wheel for zoom
            const zoomDelta = e.deltaY > 0 ? 0.9 : 1.1;
            const oldZoom = this.state.zoom;
            this.state.zoom = Math.max(0.5, Math.min(2.0, this.state.zoom * zoomDelta));
            // Keep content centered
            const zoomRatio = this.state.zoom / oldZoom;
            this.state.scrollX = this.state.scrollX * zoomRatio;
            this.state.scrollY = this.state.scrollY * zoomRatio;
            this.clampScrollIntoView();
        } else if (e.shiftKey) {
            // Shift + wheel pans vertically
            this.state.scrollY = this.state.scrollY + e.deltaY;
            this.clampScrollIntoView();
        } else {
            // Default wheel pans horizontally; vertical wheel mapped to horizontal pan
        // Nudge horizontally; when headers are stacked off-screen, just pan without showing negative space
        const panDelta = (e.deltaX !== 0 ? e.deltaX : e.deltaY);
        this.state.scrollX = this.state.scrollX + panDelta;
            this.clampScrollIntoView();
        }
        
        this.scheduleRedraw();
    }

    handleVerticalTimeScaleNavigation(deltaY) {
        // Day scale removed per requirements
        const scales = ['week', 'month', 'year'];
        const currentScale = this.props.scale || 'month';
        const currentIndex = scales.indexOf(currentScale);
        
        if (deltaY > 0 && currentIndex > 0) {
            // Scroll up - go to smaller time scale
            this.dispatchEvent('scale-change', { scale: scales[currentIndex - 1] });
        } else if (deltaY < 0 && currentIndex < scales.length - 1) {
            // Scroll down - go to larger time scale
            this.dispatchEvent('scale-change', { scale: scales[currentIndex + 1] });
        }
    }

    handleKey(e) {
        const canvas = this.canvasRef.el;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const panStepX = Math.max(40, (rect.width - this.sidebarWidth) * 0.1);
        const panStepY = this.cellHeight * 2;
        if (e.key === 'ArrowRight') {
            this.state.scrollX += panStepX;
        } else if (e.key === 'ArrowLeft') {
            this.state.scrollX -= panStepX;
        } else if (e.key === 'ArrowDown') {
            this.state.scrollY += panStepY;
        } else if (e.key === 'ArrowUp') {
            this.state.scrollY -= panStepY;
        } else if (e.key === 'Home') {
            this.handleNavigate({ type: 'today' });
            return;
        } else if ((e.key === '+' || e.key === '=') && (e.ctrlKey || e.metaKey)) {
            // Ctrl + '+' zoom in
            this.onWheel({ preventDefault: () => {}, ctrlKey: true, metaKey: false, deltaY: -1 });
            return;
        } else if ((e.key === '-' || e.key === '_') && (e.ctrlKey || e.metaKey)) {
            // Ctrl + '-' zoom out
            this.onWheel({ preventDefault: () => {}, ctrlKey: true, metaKey: false, deltaY: 1 });
            return;
        } else if (e.altKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
            // Alt + PageUp/PageDown to change time scale
            const delta = e.key === 'PageUp' ? -1 : 1;
            this.handleVerticalTimeScaleNavigation(delta);
        } else {
            return;
        }
        this.clampScrollIntoView();
        this.scheduleRedraw();
    }

    handleNavigate(detail) {
        if (!detail) return;
        const canvas = this.canvasRef.el;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const data = this.props.data;
        const dates = this.calculateDateRange(data);
        const scale = this.props.scale || 'month';

        if (detail.type === 'today') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const xToday = this.dateToX(today, dates);
            // Center today in viewport
            const centerX = this.sidebarWidth + (rect.width - this.sidebarWidth) / 2;
            this.state.scrollX = Math.max(0, xToday - centerX);
        } else if (detail.type === 'prev' || detail.type === 'next') {
            const direction = detail.type === 'prev' ? -1 : 1;
            let deltaPx = 0;
            if (scale === 'week') {
                deltaPx = this.cellWidth * 1 * direction; // one week
            } else if (scale === 'month') {
                deltaPx = this.cellWidth * 7 * direction; // approx one week jump
            } else if (scale === 'year') {
                deltaPx = this.cellWidth * 1 * direction; // one month at year scale
            }
            // Fallback: pan by half the viewport
            if (!deltaPx) {
                deltaPx = ((rect.width - this.sidebarWidth) / 2) * direction;
            }
            this.state.scrollX = this.state.scrollX + deltaPx;
        }
        this.clampScrollIntoView();
        this.scheduleRedraw();
    }

    onMouseLeave() {
        this.state.draggedTask = null;
        this.state.isPanning = false;
        this.state.tooltip.visible = false;
        this.state.hoveredTask = null;
        this.canvasRef.el.style.cursor = 'default';
        this.scheduleRedraw();
    }
}