{
    'name': 'Project Task Gantt Chart',
    'version': '17.0.6.0.0',
    'category': 'Project',
    'summary': 'A dynamic, custom Gantt chart for project tasks with advanced features.',
    'description': """
Project Task Gantt Chart - Advanced
===================================
This module provides a fully custom and dynamic Gantt chart view for project tasks, built from the ground up without external dependencies.

Features:
- Adds Start Date and End Date fields to tasks.
- End Date automatically synchronizes with the task's Deadline.
- Interactive Gantt chart with drag & drop to reschedule tasks.
- Dynamic tooltips showing task details on hover.
- Multiple grouping options (by Project, Assignee, Stage).
- Multiple time scales (Day, Week, Month, Year).
- Built with a robust, event-driven JavaScript architecture for stability.
    """,
    'author': 'ZEKROM TECHNOLOGIES',
    'depends': ['project', 'web'],
    'data': [
        'security/ir.model.access.csv',
        'views/project_task_views.xml',
        'views/project_task_gantt_views.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'project_task_gantt/static/src/scss/gantt_view.scss',
            'project_task_gantt/static/src/js/gantt_renderer.js',
            'project_task_gantt/static/src/js/gantt_view.js',
            'project_task_gantt/static/src/xml/gantt_view.xml',
        ],
    },
    'installable': True,
    'application': True,
    'auto_install': False,
    'license': 'LGPL-3',
}