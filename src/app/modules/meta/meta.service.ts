/* eslint-disable @typescript-eslint/no-explicit-any */
import Album from '../album/album.model';
import Category from '../category/category.model';
import Creator from '../creator/creator.model';
import NormalUser from '../normalUser/normalUser.model';
import Podcast from '../podcast/podcast.model';
import Report from '../report/report.model';

const getDashboardMetaData = async () => {
    const [
        totalUser,
        totalCreator,
        pendingCreator,
        totalPodcast,
        totalAlbum,
        totalCategory,
        totalReport,
        viewsAgg,
    ] = await Promise.all([
        NormalUser.countDocuments(),
        Creator.countDocuments(),
        Creator.countDocuments({ isApproved: false }),
        Podcast.countDocuments(),
        Album.countDocuments(),
        Category.countDocuments({ isDeleted: { $ne: true } }),
        Report.countDocuments(),
        Podcast.aggregate([
            { $group: { _id: null, total: { $sum: '$totalView' } } },
        ]),
    ]);

    return {
        totalUser,
        totalCreator,
        pendingCreator,
        totalPodcast,
        totalAlbum,
        totalCategory,
        totalReport,
        totalViews: viewsAgg[0]?.total ?? 0,
        // Subscriptions are not implemented on the platform yet. Kept for
        // backwards compatibility with existing clients.
        totalSubscriber: 0,
    };
};

//
const getUserChartData = async (year: number) => {
    const currentYear = year || new Date().getFullYear();

    const startOfYear = new Date(currentYear, 0, 1);
    const endOfYear = new Date(currentYear + 1, 0, 1);

    const monthlyPipeline = [
        { $match: { createdAt: { $gte: startOfYear, $lt: endOfYear } } },
        { $group: { _id: { $month: '$createdAt' }, total: { $sum: 1 } } },
        { $project: { month: '$_id', total: 1, _id: 0 } },
    ];
    const [userMonthly, creatorMonthly] = await Promise.all([
        NormalUser.aggregate(monthlyPipeline),
        Creator.aggregate(monthlyPipeline),
    ]);
    const chartData = userMonthly.map((item: any) => ({
        month: item.month,
        totalUser: item.total,
    }));

    const months = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
    ];

    const data = Array.from({ length: 12 }, (_, index) => ({
        month: months[index],
        totalUser:
            chartData.find((item) => item.month === index + 1)?.totalUser || 0,
        totalCreator:
            creatorMonthly.find((item: any) => item.month === index + 1)
                ?.total || 0,
    }));

    const yearsResult = await NormalUser.aggregate([
        {
            $group: {
                _id: { $year: '$createdAt' },
            },
        },
        {
            $project: {
                year: '$_id',
                _id: 0,
            },
        },
        {
            $sort: { year: 1 },
        },
    ]);

    const yearsDropdown = yearsResult.map((item: any) => item.year);

    return {
        chartData: data,
        yearsDropdown,
    };
};

const MetaService = {
    getDashboardMetaData,
    getUserChartData,
};

export default MetaService;
