import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import { PairStackJobCreateDto, PairStackJobResponseDto } from 'src/dtos/pair-stack-job.dto';
import { ApiTag, Permission } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { PairStackJobService } from 'src/services/pair-stack-job.service';

@ApiTags(ApiTag.Jobs)
@Controller('jobs')
export class PairStackJobController {
  constructor(private service: PairStackJobService) {}

  @Get('stack')
  @Authenticated({ permission: Permission.JobRead, admin: true })
  @Endpoint({
    summary: 'Retrieve pair-stack task status',
    description: 'Retrieve the status and progress of the custom JPG + RAW pair-stack runner.',
    history: new HistoryBuilder().added('v3.1.0').alpha('v3.1.0'),
  })
  getPairStackJob(@Auth() auth: AuthDto): Promise<PairStackJobResponseDto> {
    return this.service.get(auth);
  }

  @Post('stack')
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  @Endpoint({
    summary: 'Start or resume pair-stack task',
    description: 'Start or resume the custom JPG + RAW pair-stack runner.',
    history: new HistoryBuilder().added('v3.1.0').alpha('v3.1.0'),
  })
  async startPairStackJob(
    @Auth() auth: AuthDto,
    @Body() dto: PairStackJobCreateDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PairStackJobResponseDto> {
    const result = await this.service.create(auth, dto);
    response.status(result.status);
    return result.response;
  }
}
